import pathSearch from "path-search-sort"
import { Manifest, VersionType, LEGACY_ASSETS_BEFORE, versionKey } from "./manifest.js"
import { VersionContext } from "./version.js"
import { createStore } from "./store.js"
import { objectUrl } from "./objects.js"
import { buildZip, packEntry, decodeEntry, readZip, writeZip } from "./zip.js"
import { isNode, decoder, pool, pathFilter, define } from "./util.js"

export { VersionType, LEGACY_ASSETS_BEFORE, readZip, writeZip }

const normalisePath = p => String(p).replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "")
const nameOf = path => path.slice(path.lastIndexOf("/") + 1)

function stripNamespace(query) {
  if (typeof query !== "string") return query
  const q = query.trim()
  const colon = q.indexOf(":")
  return colon >= 0 && !q.slice(0, colon).includes("/") ? q.slice(colon + 1) : q
}

function assetPath(id, kind, ext, namespace) {
  let p = String(id).trim().replace(/\\/g, "/").replace(/^\/+/, "")
  if (!p.startsWith("assets/")) {
    let ns = namespace ?? "minecraft"
    let rest = p
    const colon = p.indexOf(":")
    if (colon >= 0 && !p.slice(0, colon).includes("/")) {
      ns = p.slice(0, colon) || ns
      rest = p.slice(colon + 1)
    }
    if (rest.startsWith(kind + "/")) rest = rest.slice(kind.length + 1)
    p = `assets/${ns}/${kind}/${rest}`
  }
  if (!p.toLowerCase().endsWith(ext)) p += ext
  return p
}

function parseLang(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return out
}

const isEntry = x => x != null && typeof x === "object" && typeof x.path === "string"

export default class MinecraftAssets {
  constructor({ cacheDir, cacheSize, cacheAPI, proxy, version, manifest, manifestExpiry, objects } = {}) {
    this._version = version ?? "release"
    this._objects = !!objects
    this._proxy = proxy
    this._store = createStore({ cacheAPI, cacheDir, cacheSize })
    this.manifest = new Manifest(this, { manifest, manifestExpiry })
    this._contexts = new Map()
    this._objectReads = new Map()
  }

  async _request(url, init) {
    let target = url
    if (typeof this._proxy === "function") target = this._proxy(url) || url
    else if (this._proxy) target = this._proxy + url
    let res
    try {
      res = await fetch(target, init)
    } catch (e) {
      if (isNode) throw e
      throw new Error(`Fetch failed for ${target}. If this is a cross-origin request, the host may not allow it and a proxy is needed (see the proxy option)`, { cause: e })
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    return res
  }

  async _fetchObject(hash, cache = true) {
    if (cache) {
      const hit = await this._store.get("blobs", hash)
      if (hit) return hit
    }
    const res = await this._request(objectUrl(hash))
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (cache) await this._store.set("blobs", hash, bytes)
    return bytes
  }

  _readObject(hash) {
    let p = this._objectReads.get(hash)
    if (!p) {
      p = this._fetchObject(hash)
      this._objectReads.set(hash, p)
      p.catch(() => { if (this._objectReads.get(hash) === p) this._objectReads.delete(hash) })
    }
    return p
  }

  get version() {
    return this.manifest.peek(this._version)?.id ?? null
  }

  async setVersion(value) {
    const v = value ?? "release"
    const entry = await this.manifest.resolve(v)
    this._version = v
    return entry
  }

  get channel() {
    return this.manifest.peek(this._version)?.type ?? null
  }

  async _ctx(version) {
    const entry = await this.manifest.resolve(version ?? this._version)
    const key = versionKey(entry)
    let ctx = this._contexts.get(key)
    if (!ctx) {
      ctx = new VersionContext(this, entry)
      this._contexts.set(key, ctx)
    }
    return ctx
  }

  _isFolderArg(a) {
    return typeof a === "string" || isEntry(a)
  }

  list(a, b) {
    const folder = this._isFolderArg(a) ? a : null
    const opts = (folder ? b : a) ?? {}
    if (opts.folders) return this._browse(folder ?? "", opts)
    return this._list(folder, opts)
  }

  async _list(folder, { version, objects } = {}) {
    const inherited = folder && typeof folder === "object" ? folder._context : null
    const ctx = await this._ctx(version ?? inherited?.version)
    const { files } = await ctx.listing(objects ?? inherited?.objects ?? this._objects)
    const prefix = folder ? normalisePath(typeof folder === "string" ? folder : folder.path) : ""
    return prefix ? files.filter(f => f.path.startsWith(prefix + "/")) : files
  }

  async _browse(folder, { version, objects } = {}) {
    const folderPath = normalisePath(typeof folder === "string" ? folder : folder.path)
    const inherited = typeof folder === "object" ? folder._context : null
    const ctx = await this._ctx(version ?? inherited?.version)
    const withObjects = objects ?? inherited?.objects ?? this._objects
    const { files: all } = await ctx.listing(withObjects)
    const prefix = folderPath ? folderPath + "/" : ""
    const files = []
    const dirs = new Map()
    for (const f of all) {
      if (!f.path.startsWith(prefix)) continue
      const rest = f.path.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash < 0) {
        files.push(f)
        continue
      }
      const name = rest.slice(0, slash)
      let d = dirs.get(name)
      if (!d) dirs.set(name, d = { jar: false, object: false })
      d[f.source] = true
    }
    const folders = [...dirs].map(([name, d]) => this._folderEntry(prefix + name, d.jar && d.object ? "both" : d.jar ? "jar" : "object", ctx, withObjects))
    return { files, folders }
  }

  _folderEntry(path, source, ctx, objects) {
    const entry = { path, source, objects }
    const context = { version: ctx.entry, objects }
    const join = rel => {
      const r = normalisePath(rel)
      return r === path || r.startsWith(path + "/") ? r : path + "/" + r
    }
    define(entry, "_context", context)
    define(entry, "list", (a, b) => {
      const target = this._isFolderArg(a) ? join(typeof a === "string" ? a : a.path) : path
      const opts = (this._isFolderArg(a) ? b : a) ?? {}
      return this.list(target, { ...opts, ...context, objects: opts.objects ?? objects })
    })
    define(entry, "search", (query, opts) => this.search(query, { ...opts, ...context, objects: opts?.objects ?? objects, root: path }))
    define(entry, "file", rel => this.file(join(rel), context))
    define(entry, "read", (x, opts) => isEntry(x) ? this.read(x, { ...opts, ...context }) : this.read(join(x), { ...opts, ...context }))
    return entry
  }

  async search(query, { version, objects, spaces = "_", ...options } = {}) {
    const ctx = await this._ctx(version)
    const { paths, byPath } = await ctx.listing(objects ?? this._objects)
    return pathSearch(paths, stripNamespace(query ?? ""), { ...options, spaces }).map(p => byPath.get(p))
  }

  async file(path, { version, objects } = {}) {
    const ctx = await this._ctx(version)
    return ctx.file(normalisePath(path), objects ?? this._objects)
  }

  async read(pathOrEntry, { version, objects, prefer } = {}) {
    if (isEntry(pathOrEntry) && typeof pathOrEntry.read === "function") return pathOrEntry.read({ prefer })
    const path = isEntry(pathOrEntry) ? pathOrEntry.path : pathOrEntry
    const ctx = await this._ctx(version)
    return ctx.read(normalisePath(path), objects ?? this._objects, prefer)
  }

  async getTexture(id, { version, meta, prefer, namespace } = {}) {
    const ctx = await this._ctx(version)
    const path = assetPath(id, "textures", ".png", namespace)
    const data = await ctx.read(path, this._objects, prefer)
    if (!data) return null
    if (!meta) return data
    const raw = await ctx.read(path + ".mcmeta", this._objects, prefer)
    return { data, meta: raw ? JSON.parse(decoder.decode(raw)) : null }
  }

  async _json(id, kind, { version, namespace } = {}) {
    const ctx = await this._ctx(version)
    const bytes = await ctx.read(assetPath(id, kind, ".json", namespace), this._objects)
    return bytes ? JSON.parse(decoder.decode(bytes)) : null
  }

  getModel(id, options) {
    return this._json(id, "models", options)
  }

  getBlockstate(id, options) {
    return this._json(id, "blockstates", options)
  }

  getItemDefinition(id, options) {
    return this._json(id, "items", options)
  }

  async getStructure(id, { version, namespace } = {}) {
    const ctx = await this._ctx(version)
    let p = String(id).trim().replace(/\\/g, "/").replace(/^\/+/, "")
    if (!p.toLowerCase().endsWith(".nbt")) p += ".nbt"
    if (p.startsWith("data/") || p.startsWith("assets/")) return ctx.read(p, this._objects)
    let ns = namespace ?? "minecraft"
    const colon = p.indexOf(":")
    if (colon >= 0 && !p.slice(0, colon).includes("/")) {
      ns = p.slice(0, colon) || ns
      p = p.slice(colon + 1)
    }
    p = p.replace(/^structures?\//, "")
    for (const base of [`data/${ns}/structure/`, `data/${ns}/structures/`, `assets/${ns}/structures/`]) {
      const bytes = await ctx.read(base + p, this._objects)
      if (bytes) return bytes
    }
    return null
  }

  async getSound(id, { version, namespace } = {}) {
    const ctx = await this._ctx(version)
    return ctx.read(assetPath(id, "sounds", ".ogg", namespace), true)
  }

  async getLang(code, { version, namespace = "minecraft" } = {}) {
    const ctx = await this._ctx(version)
    const { files } = await ctx.listing(true)
    let c = String(code).replace(/\\/g, "/")
    const colon = c.indexOf(":")
    if (colon >= 0 && !c.slice(0, colon).includes("/")) {
      namespace = c.slice(0, colon) || namespace
      c = c.slice(colon + 1)
    }
    const want = nameOf(c).replace(/\.(json|lang)$/i, "").toLowerCase()
    const dirs = [`assets/${namespace}/lang/`]
    if (ctx.entry.legacyLayout) dirs.push("lang/")
    let json = null
    let lang = null
    for (const f of files) {
      for (const dir of dirs) {
        if (!f.path.startsWith(dir)) continue
        const name = f.path.slice(dir.length)
        const m = /^([^/]*)\.(json|lang)$/i.exec(name)
        if (!m || m[1].toLowerCase() !== want) continue
        if (m[2].toLowerCase() === "json") json ??= f
        else lang ??= f
      }
    }
    const entry = json ?? lang
    if (!entry) return null
    const text = decoder.decode(await entry.read())
    return entry === json ? JSON.parse(text) : parseLang(text)
  }

  async loadJar({ version, onProgress } = {}) {
    const ctx = await this._ctx(version)
    await (await ctx.jar()).load(onProgress)
  }

  async loadObjects({ version, filter, concurrency = 32, onProgress, cache = true } = {}) {
    const ctx = await this._ctx(version)
    const index = await ctx.index()
    const keep = pathFilter(filter)
    const wanted = index ? [...index].filter(([path]) => keep(path)) : []
    const results = new Array(wanted.length)
    let done = 0
    await pool(wanted, concurrency, async ([, { hash }], i) => {
      try {
        results[i] = await this._fetchObject(hash, cache)
      } catch {}
      onProgress?.(++done, wanted.length)
    })
    const out = new Map()
    wanted.forEach(([path], i) => { if (results[i]) out.set(path, results[i]) })
    return out
  }

  async export({ version, filter, dir, objects, concurrency = 32, onProgress } = {}) {
    const ctx = await this._ctx(version)
    const { files } = await ctx.listing(objects ?? this._objects)
    const keep = pathFilter(filter)
    const wanted = files.filter(f => keep(f.path))
    const jar = await ctx.jar()
    if (wanted.some(f => f.source === "jar")) await jar.buffer()
    let done = 0
    const tick = () => onProgress?.(++done, wanted.length)

    if (dir == null) {
      const items = new Array(wanted.length)
      await pool(wanted, concurrency, async (f, i) => {
        if (f.source === "jar") {
          const { entry, data } = await jar.raw(f.path)
          items[i] = { path: f.path, method: entry.method, crc: entry.crc, size: entry.size, compressedSize: entry.compressedSize, data }
        } else {
          items[i] = await packEntry(f.path, await this._fetchObject(f.hash))
        }
        tick()
      })
      return buildZip(items)
    }

    const [fs, nodePath] = await Promise.all([import("node:fs/promises"), import("node:path")])
    await pool(wanted, concurrency, async f => {
      let bytes
      if (f.source === "jar") {
        const { entry, data } = await jar.raw(f.path)
        bytes = await decodeEntry(data, entry)
      } else {
        bytes = await this._fetchObject(f.hash)
      }
      const target = nodePath.join(dir, ...f.path.split("/"))
      await fs.mkdir(nodePath.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes)
      tick()
    })
    return wanted.length
  }

  async clearCache() {
    for (const ctx of this._contexts.values()) {
      const jar = await ctx._jar?.catch(() => null)
      await jar?._persisted
    }
    return this._store.clear()
  }
}
