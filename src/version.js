import { Jar } from "./jar.js"
import { BedrockZip } from "./bedrock.js"
import { rootIndex } from "./objects.js"
import { hashFromUrl, collator, memo, memoMap } from "./util.js"
import { versionKey } from "./manifest.js"

export class VersionContext {
  constructor(mc, entry) {
    this.mc = mc
    this.entry = entry
    this.key = versionKey(entry)
    this._details = null
    this._jar = null
    this._jarValue = null
    this._index = null
    this._listings = new Map()
  }

  details() {
    return memo(this, "_details", () => this.mc.manifest.details(this.entry))
  }

  jar() {
    return memo(this, "_jar", async () => this._jarValue = await this._openJar())
  }

  async _openJar() {
    if (this.mc._type === "assets") throw new Error("Asset index versions have no jar")
    if (this.mc._type === "bedrock") {
      const zip = this.entry.zip
      if (!zip?.url) throw new Error(`Version "${this.entry.id}" has no download`)
      return new BedrockZip({
        url: zip.url,
        size: zip.size,
        archive: zip.archive,
        key: this.entry.tag ?? this.entry.id,
        request: (url, init) => this.mc._request(url, init),
        store: this.mc._store
      })
    }
    const d = await this.details()
    const client = d.downloads?.client
    if (!client?.url) throw new Error(`Version "${this.entry.id}" has no client jar`)
    const local = await this.mc._local()
    return new Jar({
      url: client.url,
      size: client.size,
      sha1: client.sha1 ?? hashFromUrl(client.url),
      local: local ? await local.jar(this.entry.id, client) : null,
      legacyLayout: this.entry.legacyLayout,
      request: (url, init) => this.mc._request(url, init),
      store: this.mc._store
    })
  }

  index() {
    return memo(this, "_index", async () => {
      if (this.mc._type === "bedrock") return null
      const meta = this.mc._type === "assets" ? this.entry : (await this.details()).assetIndex
      const url = meta?.url
      if (!url) return null
      const store = this.mc._store
      const key = "index_" + (meta.sha1 ?? hashFromUrl(url))
      let json = await store.get("meta", key)
      if (!json?.objects) {
        const local = await this.mc._local()
        json = local ? await local.index(meta.id, meta.sha1) : null
        if (!json?.objects) {
          json = await (await this.mc._request(url)).json()
          await store.set("meta", key, json)
        }
      }
      return rootIndex(json)
    })
  }

  listing(objects) {
    if (this.mc._type !== "java") objects = false
    const key = objects ? "on" : "off"
    return memoMap(this._listings, key, () => this._buildListing(!!objects))
  }

  async _buildListing(objects) {
    if (this.mc._type === "assets") {
      const index = await this.index()
      const byPath = new Map()
      for (const [path, obj] of index) byPath.set(path, this._fileEntry(path, null, obj))
      const files = Object.freeze([...byPath.values()].sort((a, b) => collator.compare(a.path, b.path)))
      let paths
      return { files, byPath, get paths() { return paths ??= Object.freeze(files.map(f => f.path)) } }
    }
    const jar = await this.jar()
    const [listing, index] = await Promise.all([jar.listing(), objects ? this.index() : null])
    if (!listing.sorted && listing.sorting) await listing.sorting
    const { entries } = listing
    const byPath = new Map()
    for (const [path, jarEntry] of entries) byPath.set(path, this._fileEntry(path, jarEntry, index?.get(path)))
    if (index) for (const [path, obj] of index) if (!byPath.has(path)) byPath.set(path, this._fileEntry(path, null, obj))
    let list
    if (!index && listing.order) list = listing.order.map(path => byPath.get(path))
    else {
      list = [...byPath.values()]
      if (!listing.sorted || index) list.sort((a, b) => collator.compare(a.path, b.path))
    }
    const files = Object.freeze(list)
    let paths
    return { files, byPath, get paths() { return paths ??= Object.freeze(files.map(f => f.path)) } }
  }

  _fileEntry(path, jarEntry, obj) {
    return new FileEntry(this, path, jarEntry, obj)
  }

  readJar(path) {
    const jar = this._jarValue
    return jar ? jar.read(path) : this.jar().then(j => j.read(path))
  }

  async file(path, objects) {
    const { byPath } = await this.listing(objects)
    return byPath.get(path) ?? null
  }

  async read(path, objects, prefer) {
    const entry = await this.file(path, objects)
    return entry ? entry.read({ prefer }) : null
  }
}

class FileEntry {
  #ctx
  #jar
  #obj

  constructor(ctx, path, jarEntry, obj) {
    this.path = path
    if (ctx.mc._type === "java") this.source = obj ? "object" : "jar"
    this.size = (obj ?? jarEntry).size
    if (obj) this.hash = obj.hash
    else this.crc = jarEntry.crc
    this.#ctx = ctx
    this.#jar = jarEntry
    this.#obj = obj
  }

  read({ prefer } = {}) {
    const useJar = this.#jar && (!this.#obj || prefer === "jar")
    return useJar ? this.#ctx.readJar(this.path) : this.#ctx.mc._readObject(this.#obj.hash)
  }

  raw({ prefer } = {}) {
    const useJar = this.#jar && (!this.#obj || prefer === "jar")
    if (!useJar) return this.#ctx.mc._readObject(this.#obj.hash).then(bytes => ({ compression: null, bytes }))
    const ctx = this.#ctx
    const jar = ctx._jarValue
    if (jar?._list && jar._held) return Promise.resolve(rawResult(jar.rawSync(this.path)))
    return ctx.jar().then(j => j.raw(this.path)).then(rawResult)
  }
}

function rawResult(hit) {
  return hit ? { compression: hit.entry.method === 8 ? "deflate-raw" : null, bytes: hit.data } : null
}
