import { encoder, decoder } from "./util.js"

const STORES = ["meta", "blobs"]
const SAFE = /[^A-Za-z0-9_.%-]/g
const encodeKey = key => encodeURIComponent(key).replace(SAFE, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
const decodeKey = name => decodeURIComponent(name)

export class OpfsCache {
  constructor(dir, { maxSize = 1_000_000_000, key } = {}) {
    this.name = dir || "minecraft-asset-loader"
    this.key = key
    this.maxSize = maxSize == null ? Infinity : maxSize
    this._root = null
    this._index = null
  }

  async _dir(store, create = true) {
    this._root ??= navigator.storage.getDirectory()
      .then(r => r.getDirectoryHandle(this.name, { create: true }))
      .then(r => this.key ? r.getDirectoryHandle(this.key, { create: true }) : r)
    return (await this._root).getDirectoryHandle(store, { create })
  }

  async _ready() {
    if (this._index) return this._index
    const index = new Map()
    for (const store of STORES) {
      const dir = await this._dir(store, true)
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file") continue
        const file = await handle.getFile()
        index.set(store + "/" + name, { size: file.size, mtime: 0 })
      }
    }
    return this._index = index
  }

  async get(store, key) {
    const index = await this._ready()
    const name = encodeKey(key)
    let file
    try {
      file = await (await (await this._dir(store)).getFileHandle(name)).getFile()
    } catch {
      return undefined
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    index.set(store + "/" + name, { size: bytes.length, mtime: Date.now() })
    return store === "meta" ? JSON.parse(decoder.decode(bytes)) : bytes
  }

  async set(store, key, value) {
    const index = await this._ready()
    const name = encodeKey(key)
    const bytes = store === "meta" ? encoder.encode(JSON.stringify(value)) : value
    const handle = await (await this._dir(store)).getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(bytes)
    } finally {
      await writable.close()
    }
    index.set(store + "/" + name, { size: bytes.length, mtime: Date.now() })
    await this._evict()
  }

  async delete(store, key) {
    const index = await this._ready()
    const name = encodeKey(key)
    index.delete(store + "/" + name)
    await (await this._dir(store)).removeEntry(name).catch(() => {})
  }

  async list() {
    const index = await this._ready()
    return [...index.entries()].map(([id, rec]) => {
      const slash = id.indexOf("/")
      return { key: id.slice(0, slash + 1) + decodeKey(id.slice(slash + 1)), size: rec.size }
    })
  }

  async clear() {
    this._index = null
    const root = await this._root
    if (!root) return
    for (const store of STORES) await root.removeEntry(store, { recursive: true }).catch(() => {})
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
      const [store, name] = id.split("/")
      await (await this._dir(store)).removeEntry(name).catch(() => {})
    }
  }
}
