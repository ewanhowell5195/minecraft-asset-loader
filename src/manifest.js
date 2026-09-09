import { isNode, hashFromUrl, define, memoMap, pool } from "./util.js"

export const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const BEDROCK_RELEASES = "https://api.github.com/repos/Mojang/bedrock-samples/releases"
export const LEGACY_ASSETS_BEFORE = Date.parse("2013-06-13T15:32:23+00:00")
const DEFAULT_TTL = 10 * 60 * 1000

const MAIN_EXTRA = ["1.20.4", "1.20.6", "1.21.3", "1.21.4", "1.21.5", "1.21.8", "1.21.10", "1.21.11"]

function lineOf(id, bedrock) {
  if (bedrock) {
    const [major, minor, patch] = id.split(".")
    return `${major}.${minor}.${Math.floor((parseInt(patch) || 0) / 10) * 10}`
  }
  const m = /^(\d+)\.(\d+)/.exec(id)
  return m ? m[1] + "." + m[2] : id
}

function main(all) {
  const bedrock = all.some(v => v.zip)
  const releases = all.filter(v => v.type === "release")
  const keep = new Set()
  const lines = new Set()
  for (const v of releases) {
    const line = lineOf(v.id, bedrock)
    if (!lines.has(line)) {
      lines.add(line)
      keep.add(v)
    }
  }
  if (!bedrock) for (const v of releases) if (MAIN_EXTRA.includes(v.id)) keep.add(v)
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

const owners = new WeakMap()
const raws = new WeakMap()

class ManifestVersion {
  constructor(row) {
    Object.assign(this, row)
    this.legacyLayout = Date.parse(row.releaseTime) < LEGACY_ASSETS_BEFORE
  }

  details() {
    return owners.get(this).details(this)
  }

  list(a, b) {
    const mc = owners.get(this).mc
    return mc._isFolderArg(a) ? mc.list(a, { ...b, version: this }) : mc.list({ ...a, version: this })
  }
}

for (const [name, kind] of Object.entries(BOUND)) {
  ManifestVersion.prototype[name] = kind === "arg"
    ? function (x, opts) { return owners.get(this).mc[name](x, { ...opts, version: this }) }
    : function (opts) { return owners.get(this).mc[name]({ ...opts, version: this }) }
}

export class Manifest {
  constructor(mc, { manifest, manifestExpiry } = {}) {
    this.mc = mc
    this._expiry = manifestExpiry
    this._state = null
    this._owned = false
    this._expiresAt = 0
    this._pending = null
    this._persisted = null
    this._details = new Map()
    if (manifest != null) this._adopt(manifest)
  }

  get _cacheKey() {
    if (this.mc._type === "bedrock") return "bedrock_manifest"
    if (this.mc._type === "assets") return "assets_manifest"
    return "manifest"
  }

  async _current() {
    if (this._owned) return this._state
    if (this._state && Date.now() < this._expiresAt) return this._state
    let cached
    if (!this._state) {
      cached = await this.mc._store.get("meta", this._cacheKey)
      if (!(cached?.json?.versions && typeof cached.time === "number")) cached = undefined
      else {
        const expiresAt = cached.time + this._effectiveTtl(cached.ttl)
        if (Date.now() < expiresAt || !isNode) {
          this._state = this._build(cached.json)
          this._owned = false
          this._expiresAt = expiresAt
          if (Date.now() < expiresAt) return this._state
        }
      }
    }
    if (this._state && !isNode) {
      if (!this._pending) this._pending = this._fetch().catch(() => {}).finally(() => { this._pending = null })
      return this._state
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
    const { json, headers } = this.mc._type === "bedrock" ? await this._fetchBedrock()
      : this.mc._type === "assets" ? await this._fetchAssets()
      : await this._fetchJava()
    const state = this._build(json)
    const headerTtl = ttlFromHeaders(headers)
    this._state = state
    this._owned = false
    this._expiresAt = Date.now() + this._effectiveTtl(headerTtl)
    this._persisted = this.mc._store.set("meta", this._cacheKey, { time: Date.now(), ttl: headerTtl, json })
    return state
  }

  async _fetchJava() {
    const res = await this.mc._request(MANIFEST_URL)
    return { json: await res.json(), headers: res.headers }
  }

  async _fetchBedrock() {
    const versions = []
    let headers
    let page = 1
    while (true) {
      const res = await this.mc._request(`${BEDROCK_RELEASES}?per_page=100&page=${page++}`)
      const batch = await res.json()
      for (const r of batch) {
        const asset = r.assets?.find(a => a.name.endsWith("-full.zip"))
        versions.push({
          id: r.tag_name.replace(/^v/, ""),
          type: r.prerelease ? "snapshot" : "release",
          releaseTime: r.published_at,
          tag: r.tag_name,
          zip: asset
            ? { url: asset.browser_download_url, size: asset.size }
            : { url: `https://github.com/Mojang/bedrock-samples/archive/refs/tags/${r.tag_name}.zip`, size: null, archive: true }
        })
      }
      headers = res.headers
      if (batch.length < 100) break
    }
    return { json: { versions }, headers }
  }

  async _fetchAssets() {
    const res = await this.mc._request(MANIFEST_URL)
    const json = await res.json()
    const rows = json.versions
    const store = this.mc._store
    const known = new Array(rows.length)
    const probes = new Map()
    const mc = this.mc
    function probe(i) {
      return memoMap(probes, i, async () => {
        const key = "details_" + hashFromUrl(rows[i].url)
        let d = await store.get("meta", key)
        if (!d?.downloads) {
          d = await (await mc._request(rows[i].url)).json()
          await store.set("meta", key, d)
        }
        return known[i] = d.assetIndex ?? null
      })
    }
    // April window: april fools builds are the only versions with a unique single-use index
    function april(row) {
      const d = new Date(row.releaseTime)
      const m = d.getUTCMonth()
      return (m === 2 && d.getUTCDate() >= 25) || (m === 3 && d.getUTCDate() <= 7)
    }
    const anchors = []
    for (let i = 0; i < rows.length; i++) {
      if (i === 0 || i === rows.length - 1 || rows[i].type === "release" || april(rows[i])) anchors.push(i)
    }
    await pool(anchors, 32, probe)
    const gaps = []
    const edges = new Set()
    for (let a = 1; a < anchors.length; a++) {
      const lo = anchors[a - 1] + 1
      const hi = anchors[a] - 1
      if (hi < lo) continue
      gaps.push([lo, hi])
      edges.add(lo).add(hi)
    }
    await pool([...edges], 32, probe)
    async function solve(lo, hi) {
      if (hi - lo < 1) return
      if (hi - lo - 1 <= 2) {
        await Promise.all(Array.from({ length: hi - lo + 1 }, (_, k) => probe(lo + k)))
        return
      }
      const [a, b] = await Promise.all([probe(lo), probe(hi)])
      if (a?.id === b?.id) return
      const mid = (lo + hi) >> 1
      await probe(mid)
      await Promise.all([solve(lo, mid), solve(mid, hi)])
    }
    await Promise.all(gaps.map(([lo, hi]) => solve(lo, hi)))
    for (let i = 1; i < rows.length; i++) if (known[i] === undefined) known[i] = known[i - 1]
    const byId = new Map()
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      const index = known[i]
      if (!index) continue
      const cur = byId.get(index.id)
      if (!cur) {
        byId.set(index.id, {
          id: index.id,
          type: row.type === "release" ? "release" : "snapshot",
          releaseTime: row.releaseTime,
          sha1: index.sha1,
          url: index.url,
          size: index.size,
          totalSize: index.totalSize,
          first: row.id,
          last: row.id
        })
      } else {
        if (row.type === "release") cur.type = "release"
        cur.last = row.id
      }
    }
    const versions = [...byId.values()].sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime))
    return { json: { versions }, headers: res.headers }
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
      if (old && raws.get(old) === JSON.stringify(row)) return old
      return this._enrich(row)
    })
    const byId = new Map()
    for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e)
    return { entries, byId }
  }

  _enrich(row) {
    const entry = new ManifestVersion(row)
    owners.set(entry, this)
    raws.set(entry, JSON.stringify(row))
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
    return memoMap(this._details, key, () => this._fetchDetails(entry, key))
  }

  async _fetchDetails(entry, key) {
    const store = this.mc._store
    const type = this.mc._type
    const cacheKey = (type === "bedrock" ? "bedrock_details_" : type === "assets" ? "index_" : "details_") + key
    const cached = await store.get("meta", cacheKey)
    if (cached && typeof cached === "object") return cached
    const res = await this.mc._request(type === "bedrock" ? `${BEDROCK_RELEASES}/tags/${entry.tag}` : entry.url)
    const json = await res.json()
    await store.set("meta", cacheKey, json)
    return json
  }
}
