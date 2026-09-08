import { decodeEntry, decodeEntrySync, inflateRaw } from "./zip.js"
import { memo, memoMap } from "./util.js"

export class ZipSource {
  constructor({ url, size, request, store }) {
    this.url = url
    this.size = size
    this.request = request
    this.store = store
    this._listing = null
    this._list = null
    this._buffer = null
    this._held = null
    this._persisted = null
    this._persistedMeta = null
    this._progress = null
    this._reads = new Map()
  }

  buffer() {
    return memo(this, "_buffer", async () => this._held = await this._loadBuffer())
  }

  listing() {
    return memo(this, "_listing", async () => this._list = await this._loadListing())
  }

  async load(onProgress) {
    this._progress = onProgress
    try {
      const [, held] = await Promise.all([this.listing(), this.buffer()])
      if (onProgress) {
        const total = Array.isArray(held) ? held.reduce((n, c) => n + c.bytes.length, 0) : held.length
        onProgress(total, total)
      }
    } finally {
      this._progress = null
    }
  }

  async settled() {
    await this._persisted
    await this._list?.sorting
    await this._persistedMeta
  }

  async extract(path) {
    const hit = await this.raw(path)
    return hit ? decodeEntry(hit.data, hit.entry) : null
  }

  read(path) {
    const hit = this._reads.get(path)
    if (hit) return hit
    if (!this._list || !this._held) return memoMap(this._reads, path, () => this.extract(path))
    let p
    try {
      const raw = this.rawSync(path)
      const bytes = raw && decodeEntrySync(raw.data, raw.entry)
      p = !raw ? Promise.resolve(null) : bytes ? Promise.resolve(bytes) : inflateRaw(raw.data)
    } catch (e) {
      p = Promise.reject(e)
    }
    this._reads.set(path, p)
    p.catch(() => { if (this._reads.get(path) === p) this._reads.delete(path) })
    return p
  }
}
