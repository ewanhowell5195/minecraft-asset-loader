import { decodeEntry } from "./zip.js"
import { memo, memoMap } from "./util.js"

export class ZipSource {
  constructor({ url, size, request, store }) {
    this.url = url
    this.size = size
    this.request = request
    this.store = store
    this._listing = null
    this._buffer = null
    this._persisted = null
    this._progress = null
    this._reads = new Map()
  }

  buffer() {
    return memo(this, "_buffer", () => this._loadBuffer())
  }

  listing() {
    return memo(this, "_listing", () => this._loadListing())
  }

  async load(onProgress) {
    this._progress = onProgress
    try {
      await this.listing()
      const held = await this.buffer()
      if (onProgress) {
        const total = Array.isArray(held) ? held.reduce((n, c) => n + c.bytes.length, 0) : held.length
        onProgress(total, total)
      }
    } finally {
      this._progress = null
    }
  }

  async extract(path) {
    const hit = await this.raw(path)
    return hit ? decodeEntry(hit.data, hit.entry) : null
  }

  read(path) {
    return memoMap(this._reads, path, () => this.extract(path))
  }
}
