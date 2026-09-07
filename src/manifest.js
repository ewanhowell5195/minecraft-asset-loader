import { isNode, hashFromUrl, define } from "./util.js"

export const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
export const LEGACY_ASSETS_BEFORE = Date.parse("2013-06-13T15:32:23+00:00")
const DEFAULT_TTL = 10 * 60 * 1000

const MAIN_EXTRA = ["1.20.4", "1.20.6", "1.21.3", "1.21.4", "1.21.5", "1.21.8", "1.21.10", "1.21.11"]

const lineOf = id => {
  const m = /^(\d+)\.(\d+)/.exec(id)
  return m ? m[1] + "." + m[2] : id
}

function main(all) {
  const releases = all.filter(v => v.type === "release")
  const keep = new Set()
  const lines = new Set()
  for (const v of releases) {
    const line = lineOf(v.id)
    if (!lines.has(line)) {
      lines.add(line)
      keep.add(v)
    }
  }
  for (const v of releases) if (MAIN_EXTRA.includes(v.id)) keep.add(v)
  const snapshot = all.find(v => v.type === "snapshot")
  if (snapshot && (!releases[0] || Date.parse(snapshot.releaseTime) > Date.parse(releases[0].releaseTime))) keep.add(snapshot)
  return all.filter(v => keep.has(v))
}

export const VersionType = {
  RELEASE: "release",
  SNAPSHOT: "snapshot",
  BETA: "old_beta",
  ALPHA: "old_alpha",
  MAIN: main,
  MODERN: all => all.filter(v => !v.legacyLayout)
}

function applyFilter(all, filter) {
  if (filter == null) return all.slice()
  if (typeof filter === "string") return all.filter(v => v.type === filter)
  if (typeof filter === "function") return filter(all)
  if (Array.isArray(filter)) {
    const keep = new Set()
    for (const f of filter) for (const v of applyFilter(all, f)) keep.add(v)
    return all.filter(v => keep.has(v))
  }
  throw new TypeError("Unsupported version filter")
}

function ttlFromHeaders(headers) {
  const control = headers.get("cache-control")
  const m = control && /max-age=(\d+)/i.exec(control)
  if (m) {
    const age = parseInt(headers.get("age") ?? "0", 10) || 0
    return Math.max(0, (Number(m[1]) - age) * 1000)
  }
  const expires = headers.get("expires")
  if (expires) {
    const until = Date.parse(expires)
    const date = Date.parse(headers.get("date") ?? "")
    if (!Number.isNaN(until)) return Math.max(0, until - (Number.isNaN(date) ? Date.now() : date))
  }
  return DEFAULT_TTL
}

export const versionKey = row => row.sha1 ?? (row.url ? hashFromUrl(row.url) : row.id)

const BOUND = {
  search: "arg", file: "arg", read: "arg",
  getTexture: "arg", getModel: "arg", getBlockstate: "arg", getItemDefinition: "arg", getSound: "arg", getLang: "arg", getStructure: "arg",
  loadJar: "opts", loadObjects: "opts", export: "opts"
}

export class Manifest {
  constructor(mc, { manifest, manifestExpiry } = {}) {
    this.mc = mc
    this._expiry = manifestExpiry
    this._state = null
    this._owned = false
    this._expiresAt = 0
    this._pending = null
    this._details = new Map()
    if (manifest != null) this._adopt(manifest)
  }

  async _current() {
    if (this._owned) return this._state
    if (this._state && Date.now() < this._expiresAt) return this._state
    let cached
    if (!this._state && isNode) {
      cached = await this.mc._store.get("meta", "manifest")
      if (!(cached?.json?.versions && typeof cached.time === "number")) cached = undefined
      else if (Date.now() < cached.time + this._effectiveTtl(cached.ttl)) {
        this._state = this._build(cached.json)
        this._owned = false
        this._expiresAt = cached.time + this._effectiveTtl(cached.ttl)
        return this._state
      }
    }
    if (!this._pending) {
      this._pending = this._fetch().finally(() => { this._pending = null })
    }
    try {
      return await this._pending
    } catch (e) {
      if (this._state) return this._state
      if (cached) {
        this._state = this._build(cached.json)
        this._owned = false
        this._expiresAt = 0
        return this._state
      }
      throw e
    }
  }

  _effectiveTtl(headerTtl) {
    return this._expiry === undefined ? headerTtl : (this._expiry == null ? Infinity : this._expiry)
  }

  async _fetch() {
    const res = await this.mc._request(MANIFEST_URL)
    const json = await res.json()
    const state = this._build(json)
    const headerTtl = ttlFromHeaders(res.headers)
    this._state = state
    this._owned = false
    this._expiresAt = Date.now() + this._effectiveTtl(headerTtl)
    if (isNode) await this.mc._store.set("meta", "manifest", { time: Date.now(), ttl: headerTtl, json })
    return state
  }

  _adopt(json) {
    if (!json || typeof json !== "object" || !Array.isArray(json.versions)) throw new TypeError("Not a version manifest")
    this._state = this._build(JSON.parse(JSON.stringify(json)))
    this._owned = true
    this._expiresAt = Infinity
  }

  _build(json) {
    if (!json || !Array.isArray(json.versions)) throw new TypeError("Not a version manifest")
    const previous = new Map()
    if (this._state) for (const e of this._state.entries) previous.set(versionKey(e), e)
    const entries = json.versions.map(row => {
      const old = previous.get(versionKey(row))
      if (old && old._raw === JSON.stringify(row)) return old
      return this._enrich(row)
    })
    const byId = new Map()
    for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e)
    return { entries, byId }
  }

  _enrich(row) {
    const mc = this.mc
    const entry = { ...row, legacyLayout: Date.parse(row.releaseTime) < LEGACY_ASSETS_BEFORE }
    define(entry, "_raw", JSON.stringify(row))
    define(entry, "details", () => this.details(entry))
    define(entry, "list", (a, b) => mc._isFolderArg(a) ? mc.list(a, { ...b, version: entry }) : mc.list({ ...a, version: entry }))
    for (const [name, kind] of Object.entries(BOUND)) {
      define(entry, name, kind === "arg"
        ? (x, opts) => mc[name](x, { ...opts, version: entry })
        : opts => mc[name]({ ...opts, version: entry }))
    }
    return entry
  }

  async versions(filter) {
    const { entries } = await this._current()
    return applyFilter(entries, filter)
  }

  async version(id) {
    const state = await this._current()
    if (id === "release" || id === "snapshot" || id === "newest") return this._latest(state)[id]
    return state.byId.get(id) ?? null
  }

  async latest() {
    return this._latest(await this._current())
  }

  _latest({ entries }) {
    return {
      release: entries.find(v => v.type === "release") ?? null,
      snapshot: entries.find(v => v.type === "snapshot") ?? null,
      newest: entries[0] ?? null
    }
  }

  peek(version) {
    const state = this._state
    if (!state) return null
    if (version === "release" || version === "snapshot" || version === "newest") return this._latest(state)[version]
    const id = typeof version === "object" && version !== null ? version.id : version
    return state.byId.get(id) ?? null
  }

  async update(json) {
    if (json !== undefined) {
      this._adopt(json)
      return
    }
    await this._fetch()
  }

  async resolve(version) {
    if (version === "release" || version === "snapshot" || version === "newest") {
      const entry = (await this.latest())[version]
      if (!entry) throw new Error(`No ${version} version in the manifest`)
      return entry
    }
    const id = typeof version === "object" && version !== null ? version.id : version
    const entry = await this.version(id)
    if (entry) return entry
    if (typeof version === "object" && version !== null && version.url) return version
    throw new Error(`Unknown version "${id}"`)
  }

  async details(version) {
    const entry = await this.resolve(version)
    const key = versionKey(entry)
    let p = this._details.get(key)
    if (!p) {
      p = this._fetchDetails(entry, key)
      this._details.set(key, p)
      p.catch(() => { if (this._details.get(key) === p) this._details.delete(key) })
    }
    return p
  }

  async _fetchDetails(entry, key) {
    const store = this.mc._store
    const cacheKey = "details_" + key
    const cached = await store.get("meta", cacheKey)
    if (cached && typeof cached === "object") return cached
    const res = await this.mc._request(entry.url)
    const json = await res.json()
    await store.set("meta", cacheKey, json)
    return json
  }
}
