import { parseZip, rawFromBuffer } from "./zip.js"
import { ZipSource } from "./source.js"
import { readBody } from "./util.js"

const skip = path => path.startsWith(".github/") || path === ".gitignore" || (!path.includes("/") && path.toLowerCase().endsWith(".md"))

export class BedrockZip extends ZipSource {
  constructor(options) {
    super(options)
    this.archive = options.archive
    this.key = options.key
  }

  get blobKey() { return "bedrock_" + this.key }

  async _loadBuffer() {
    const cached = await this.store.get("blobs", this.blobKey)
    if (cached) return cached
    const res = await this.request(this.url)
    const total = this.size ?? (Number(res.headers.get("content-length")) || null)
    let done = 0
    const bytes = await readBody(res, this._progress ? n => this._progress(done += n, total) : undefined)
    this._persisted = this.store.set("blobs", this.blobKey, bytes).catch(() => {})
    return bytes
  }

  async _loadListing() {
    const buf = await this.buffer()
    const map = new Map()
    for (const e of parseZip(buf).entries) {
      if (e.path.endsWith("/")) continue
      let path = e.path
      if (this.archive) {
        const slash = path.indexOf("/")
        if (slash < 0) continue
        path = path.slice(slash + 1)
      }
      if (!path || skip(path)) continue
      map.set(path, { ...e, path })
    }
    return { entries: map }
  }

  async raw(path) {
    const { entries } = await this.listing()
    const entry = entries.get(path)
    if (!entry) return null
    return { entry, data: rawFromBuffer(await this.buffer(), entry) }
  }
}
