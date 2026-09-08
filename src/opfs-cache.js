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
    this._scan = null
    this._touched = new Map()
    this._dirs = new Map()
    this._evicting = null
    this._rootDir().catch(() => {})
  }

  _rootDir() {
    return this._root ??= navigator.storage.getDirectory()
      .then(r => r.getDirectoryHandle(this.name, { create: true }))
      .then(r => this.key ? r.getDirectoryHandle(this.key, { create: true }) : r)
  }

  _dir(store) {
    this._rootDir()
    let dir = this._dirs.get(store)
    if (!dir) {
      dir = this._root.then(r => r.getDirectoryHandle(store, { create: true }))
      this._dirs.set(store, dir)
      dir.catch(() => this._dirs.delete(store))
    }
    return dir
  }

  async _ready() {
    if (this._index) return this._index
    if (!this._scan) this._scan = this._load().then(index => this._index = index)
    return this._scan
  }

  async _load() {
    const index = new Map()
    for (const store of STORES) {
      const dir = await this._dir(store)
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file") continue
        const file = await handle.getFile()
        const id = store + "/" + name
        index.set(id, { size: file.size, mtime: this._touched.get(id) ?? file.lastModified })
      }
    }
    return index
  }

  _touch(id, size) {
    const now = Date.now()
    this._touched.set(id, now)
    if (this._index) {
      const rec = this._index.get(id)
      if (rec) rec.mtime = now
      else this._index.set(id, { size, mtime: now })
    }
  }

  async get(store, key) {
    const name = encodeKey(key)
    let file
    try {
      file = await (await (await this._dir(store)).getFileHandle(name)).getFile()
    } catch {
      return undefined
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    this._touch(store + "/" + name, bytes.length)
    return store === "meta" ? JSON.parse(decoder.decode(bytes)) : bytes
  }

  async set(store, key, value) {
    const name = encodeKey(key)
    const bytes = store === "meta" ? encoder.encode(JSON.stringify(value)) : value
    const handle = await (await this._dir(store)).getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(bytes)
    } finally {
      await writable.close()
    }
    const id = store + "/" + name
    this._touched.set(id, Date.now())
    if (this._index) this._index.set(id, { size: bytes.length, mtime: Date.now() })
    this._evictLater()
  }

  _evictLater() {
    if (!isFinite(this.maxSize) || this._evicting) return
    this._evicting = new Promise(resolve => setTimeout(resolve, 0))
      .then(() => this._ready())
      .then(() => this._evict())
      .catch(() => {})
      .finally(() => { this._evicting = null })
  }

  async delete(store, key) {
    const name = encodeKey(key)
    this._index?.delete(store + "/" + name)
    this._touched.delete(store + "/" + name)
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
    this._scan = null
    this._touched.clear()
    this._dirs.clear()
    const root = await this._rootDir()
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
