import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const STORES = ["meta", "blobs"]
const SAFE = /[^A-Za-z0-9_.%-]/g

const encodeKey = key => encodeURIComponent(key).replace(SAFE, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
const decodeKey = name => decodeURIComponent(name)

export class FileCache {
  constructor(dir, { maxSize = 1_000_000_000, key } = {}) {
    this.dir = path.join(dir || path.join(os.tmpdir(), "minecraft-asset-loader"), key ?? "")
    this.maxSize = maxSize == null ? Infinity : maxSize
    this._index = null
    this._scan = null
  }

  _file(store, key) {
    if (!STORES.includes(store)) throw new Error("Unknown store " + store)
    return path.join(this.dir, store, encodeKey(key))
  }

  async _ready() {
    if (this._index) return this._index
    if (!this._scan) this._scan = this._load().then(index => this._index = index)
    return this._scan
  }

  async _load() {
    const index = new Map()
    for (const store of STORES) {
      const dir = path.join(this.dir, store)
      const names = await fs.readdir(dir).catch(() => [])
      await Promise.all(names.map(async name => {
        if (name.includes(".tmp-")) return
        const st = await fs.stat(path.join(dir, name)).catch(() => null)
        if (st?.isFile()) index.set(store + "/" + name, { size: st.size, mtime: st.mtimeMs })
      }))
    }
    return index
  }

  async get(store, key) {
    const file = this._file(store, key)
    const index = await this._ready()
    let data
    try {
      data = await fs.readFile(file)
    } catch {
      return undefined
    }
    const now = Date.now()
    fs.utimes(file, now / 1000, now / 1000).catch(() => {})
    const id = store + "/" + path.basename(file)
    const rec = index.get(id)
    if (rec) rec.mtime = now
    else index.set(id, { size: data.length, mtime: now })
    if (store === "meta") return JSON.parse(data.toString("utf8"))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  async set(store, key, value) {
    const file = this._file(store, key)
    const index = await this._ready()
    const bytes = store === "meta" ? Buffer.from(JSON.stringify(value), "utf8") : value
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + ".tmp-" + Math.random().toString(36).slice(2)
    try {
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
    index.set(store + "/" + path.basename(file), { size: bytes.length, mtime: Date.now() })
    await this._evict()
  }

  async delete(store, key) {
    const file = this._file(store, key)
    const index = await this._ready()
    index.delete(store + "/" + path.basename(file))
    await fs.rm(file, { force: true })
  }

  async list() {
    const index = await this._ready()
    return [...index.entries()].map(([id, rec]) => {
      const slash = id.indexOf("/")
      return { key: id.slice(0, slash + 1) + decodeKey(id.slice(slash + 1)), size: rec.size }
    })
  }

  async keys(store) {
    const names = await fs.readdir(path.join(this.dir, store)).catch(() => [])
    return names.filter(n => !n.includes(".tmp-")).map(decodeKey)
  }

  async clear() {
    this._index = null
    this._scan = null
    for (const store of STORES) await fs.rm(path.join(this.dir, store), { recursive: true, force: true })
  }

  async _evict() {
    if (!isFinite(this.maxSize)) return
    const index = this._index
    let total = 0
    for (const rec of index.values()) total += rec.size
    if (total <= this.maxSize) return
    const order = [...index.entries()].sort((a, b) => a[1].mtime - b[1].mtime)
    for (const [id, rec] of order) {
      if (total <= this.maxSize) break
      index.delete(id)
      total -= rec.size
      await fs.rm(path.join(this.dir, id), { force: true }).catch(() => {})
    }
  }
}
