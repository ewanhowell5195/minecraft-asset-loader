import { Jar } from "./jar.js"
import { rootIndex } from "./objects.js"
import { hashFromUrl, collator, memo, define } from "./util.js"
import { versionKey } from "./manifest.js"

export class VersionContext {
  constructor(mc, entry) {
    this.mc = mc
    this.entry = entry
    this.key = versionKey(entry)
    this._details = null
    this._jar = null
    this._index = null
    this._listings = new Map()
  }

  details() {
    return memo(this, "_details", () => this.mc.manifest.details(this.entry))
  }

  jar() {
    return memo(this, "_jar", async () => {
      const d = await this.details()
      const client = d.downloads?.client
      if (!client?.url) throw new Error(`Version "${this.entry.id}" has no client jar`)
      return new Jar({
        url: client.url,
        size: client.size,
        sha1: client.sha1 ?? hashFromUrl(client.url),
        legacyLayout: this.entry.legacyLayout,
        request: (url, init) => this.mc._request(url, init),
        store: this.mc._store
      })
    })
  }

  index() {
    return memo(this, "_index", async () => {
      const d = await this.details()
      const url = d.assetIndex?.url
      if (!url) return null
      const store = this.mc._store
      const key = "index_" + (d.assetIndex.sha1 ?? hashFromUrl(url))
      let json = await store.get("meta", key)
      if (!json?.objects) {
        json = await (await this.mc._request(url)).json()
        await store.set("meta", key, json)
      }
      return rootIndex(json)
    })
  }

  listing(objects) {
    const key = objects ? "on" : "off"
    let p = this._listings.get(key)
    if (!p) {
      p = this._buildListing(!!objects)
      this._listings.set(key, p)
      p.catch(() => { if (this._listings.get(key) === p) this._listings.delete(key) })
    }
    return p
  }

  async _buildListing(objects) {
    const jar = await this.jar()
    const [{ entries }, index] = await Promise.all([jar.listing(), objects ? this.index() : null])
    const byPath = new Map()
    for (const [path, jarEntry] of entries) byPath.set(path, this._fileEntry(path, jarEntry, index?.get(path)))
    if (index) for (const [path, obj] of index) if (!byPath.has(path)) byPath.set(path, this._fileEntry(path, null, obj))
    const files = Object.freeze([...byPath.values()].sort((a, b) => collator.compare(a.path, b.path)))
    const paths = Object.freeze(files.map(f => f.path))
    return { files, paths, byPath }
  }

  _fileEntry(path, jarEntry, obj) {
    const entry = { path, source: obj ? "object" : "jar", size: (obj ?? jarEntry).size }
    if (obj) entry.hash = obj.hash
    else entry.crc = jarEntry.crc
    define(entry, "read", ({ prefer } = {}) => {
      const useJar = jarEntry && (!obj || prefer === "jar")
      return useJar ? this.readJar(path) : this.mc._readObject(obj.hash)
    })
    define(entry, "raw", async ({ prefer } = {}) => {
      const useJar = jarEntry && (!obj || prefer === "jar")
      if (!useJar) return { compression: null, bytes: await this.mc._readObject(obj.hash) }
      const hit = await (await this.jar()).raw(path)
      return { compression: hit.entry.method === 8 ? "deflate-raw" : null, bytes: hit.data }
    })
    return entry
  }

  async readJar(path) {
    return (await this.jar()).read(path)
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
