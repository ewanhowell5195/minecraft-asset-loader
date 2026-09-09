import { findEocd, parseEocd, parseCentralDirectory, rawFromBuffer } from "./zip.js"
import { ZipSource } from "./source.js"
import { encoder, pool, readBody, memo, collator } from "./util.js"

const TAIL_PROBE = 65536
const TAIL_PROBE_MAX = 4 << 20
const LOCAL_PAD = 4096
const MERGE_GAP = 65536
const RANGE_CONCURRENCY = 6

const PACK_MAGIC = 0x4a41434d
const PACK_HEADER = 8
const PACK_ENTRY = 16

const isDirectory = path => path.endsWith("/")

export function isData(path, legacyLayout) {
  if (isDirectory(path)) return false
  if (legacyLayout) return !path.endsWith(".class") && !path.startsWith("META-INF/")
  if (path.startsWith("assets/") || path.startsWith("data/")) return !path.endsWith("/.mcassetsroot")
  return path === "pack.png" || path === "pack.mcmeta" || path === "version.json"
}

export function packChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.bytes.length, 0)
  const out = new Uint8Array(PACK_HEADER + chunks.length * PACK_ENTRY + total)
  const view = new DataView(out.buffer)
  view.setUint32(0, PACK_MAGIC, true)
  view.setUint32(4, chunks.length, true)
  let at = PACK_HEADER + chunks.length * PACK_ENTRY
  chunks.forEach((c, i) => {
    view.setFloat64(PACK_HEADER + i * PACK_ENTRY, c.start, true)
    view.setFloat64(PACK_HEADER + i * PACK_ENTRY + 8, c.bytes.length, true)
    out.set(c.bytes, at)
    at += c.bytes.length
  })
  return out
}

export function unpackChunks(packed, size) {
  if (packed.length < PACK_HEADER) return null
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  if (view.getUint32(0, true) !== PACK_MAGIC) return null
  const count = view.getUint32(4, true)
  let at = PACK_HEADER + count * PACK_ENTRY
  if (count === 0 || at > packed.length) return null
  const chunks = []
  for (let i = 0; i < count; i++) {
    const start = view.getFloat64(PACK_HEADER + i * PACK_ENTRY, true)
    const length = view.getFloat64(PACK_HEADER + i * PACK_ENTRY + 8, true)
    if (at + length > packed.length || start + length > size) return null
    chunks.push({ start, bytes: packed.subarray(at, at + length) })
    at += length
  }
  const last = chunks[chunks.length - 1]
  return last.start + last.bytes.length === size ? chunks : null
}

export class Jar extends ZipSource {
  constructor(options) {
    super(options)
    this.sha1 = options.sha1
    this.legacyLayout = options.legacyLayout
    this.local = options.local ?? null
    this._cached = null
    this._tail = null
  }

  get metaKey() { return "jar_" + this.sha1 }
  get blobKey() { return "jar_" + this.sha1 }

  async _range(start, end, tick) {
    if (this.local) {
      try {
        return await this._readLocal(start, end, tick)
      } catch {
        this.local = null
      }
    }
    const res = await this.request(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } })
    const wanted = end - start
    const bytes = tick && res.body ? await readBody(res, tick, wanted) : new Uint8Array(await res.arrayBuffer())
    if (res.status !== 206 || bytes.length !== wanted) throw new Error(`Ranged request refused (${res.status}, ${bytes.length} bytes for ${wanted}) by ${this.url}`)
    if (tick && !res.body) tick(wanted)
    return bytes
  }

  async _readLocal(start, end, tick) {
    const fs = await import("node:fs/promises")
    const handle = await fs.open(this.local, "r")
    try {
      const bytes = new Uint8Array(end - start)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start)
      if (bytesRead !== bytes.length) throw new Error("Short read")
      tick?.(bytes.length)
      return bytes
    } finally {
      await handle.close()
    }
  }

  cached() {
    return memo(this, "_cached", () => this._loadCached())
  }

  async _loadCached() {
    const packed = await this.store.get("blobs", this.blobKey)
    if (!packed) return null
    const chunks = unpackChunks(packed, this.size)
    if (!chunks) await this.store.delete("blobs", this.blobKey)
    return chunks
  }

  async _loadListing() {
    const cached = await this.store.get("meta", this.metaKey)
    if (cached?.entries && cached.size === this.size) return this._inflateListing(cached)
    const chunks = await this.cached()
    if (chunks) return this._listingFromZip(this._parseTail(chunks[chunks.length - 1]))
    return this._probe()
  }

  _parseTail(chunk) {
    const at = findEocd(chunk.bytes)
    if (at < 0) throw new Error("No zip end record found in " + this.url)
    const eocd = parseEocd(chunk.bytes, at)
    return { ...eocd, entries: parseCentralDirectory(chunk.bytes.subarray(eocd.cdOffset - chunk.start, eocd.cdOffset - chunk.start + eocd.cdSize)) }
  }

  _inflateListing({ entries, cdOffset, cdSize, sorted }) {
    const map = new Map()
    for (const [path, offset, compressedSize, size, method, crc] of entries) {
      map.set(path, { path, offset, compressedSize, size, method, crc })
    }
    return { entries: map, cdOffset, cdSize, sorted: !!sorted }
  }

  _listingFromZip({ entries, cdOffset, cdSize }) {
    const map = new Map()
    for (const e of entries) if (isData(e.path, this.legacyLayout)) map.set(e.path, e)
    const listing = { entries: map, cdOffset, cdSize, sorted: false }
    listing.sorting = new Promise(resolve => setTimeout(resolve, 0)).then(() => {
      const data = [...map.values()].sort((a, b) => collator.compare(a.path, b.path))
      listing.order = data.map(e => e.path)
      listing.sorted = true
      this._persistedMeta = this.store.set("meta", this.metaKey, {
        size: this.size,
        cdOffset,
        cdSize,
        sorted: true,
        entries: data.map(e => [e.path, e.offset, e.compressedSize, e.size, e.method, e.crc])
      })
    })
    return listing
  }

  async _probe() {
    const tailStart = Math.max(0, this.size - Math.min(TAIL_PROBE_MAX, Math.max(TAIL_PROBE, Math.round(this.size / 10))))
    const tail = await this._range(tailStart, this.size)
    const at = findEocd(tail)
    if (at < 0) throw new Error("No zip end record found in " + this.url)
    const eocd = parseEocd(tail, at)
    let chunk = { start: tailStart, bytes: tail }
    if (eocd.cdOffset < tailStart) {
      const head = await this._range(eocd.cdOffset, tailStart)
      const bytes = new Uint8Array(this.size - eocd.cdOffset)
      bytes.set(head, 0)
      bytes.set(tail, tailStart - eocd.cdOffset)
      chunk = { start: eocd.cdOffset, bytes }
    }
    this._tail = chunk
    return this._listingFromZip(this._parseTail(chunk))
  }

  async _loadBuffer() {
    const cached = await this.cached()
    if (cached) return cached
    const { entries, cdOffset } = await this.listing()
    const tail = this._tail
    const ranges = [...entries.values()].map(e => this._entryRange(e, tail ? tail.start : this.size))
    if (!tail) ranges.push([cdOffset, this.size])
    const merged = mergeRanges(ranges, MERGE_GAP)
    const onProgress = this._progress
    let tick
    if (onProgress) {
      const total = merged.reduce((n, [start, end]) => n + end - start, 0)
      let done = 0
      onProgress(0, total)
      tick = n => onProgress(done += n, total)
    }
    const chunks = []
    await pool(merged, RANGE_CONCURRENCY, async ([start, end]) => {
      chunks.push({ start, bytes: await this._range(start, end, tick) })
    })
    if (tail) chunks.push(tail)
    chunks.sort((a, b) => a.start - b.start)
    if (!this.local) this._persisted = this._persist(chunks)
    return chunks
  }

  async _persist(chunks) {
    try {
      await this.store.set("blobs", this.blobKey, packChunks(chunks))
    } catch {}
  }

  _entryRange(e, limit) {
    const end = e.offset + 30 + (e.nameLen ?? encoder.encode(e.path).length) + e.compressedSize + LOCAL_PAD
    return [e.offset, Math.min(limit, end)]
  }

  async raw(path) {
    if (this._list && this._held) return this.rawSync(path)
    await Promise.all([this.listing(), this.buffer()])
    return this.rawSync(path)
  }

  rawSync(path) {
    const entry = this._list.entries.get(path)
    if (!entry) return null
    const chunks = this._held
    const chunk = chunks.findLast(c => c.start <= entry.offset)
    return { entry, data: rawFromBuffer(chunk.bytes, { ...entry, offset: entry.offset - chunk.start }) }
  }
}

export function mergeRanges(ranges, gap) {
  const sorted = ranges.filter(r => r[1] > r[0]).sort((a, b) => a[0] - b[0])
  const out = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}
