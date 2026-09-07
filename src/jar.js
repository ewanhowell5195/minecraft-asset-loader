import { findEocd, parseEocd, parseCentralDirectory, rawFromBuffer, decodeEntry, inflateRaw, deflateRaw } from "./zip.js"
import { encoder, pool, memo } from "./util.js"

const TAIL_PROBE = 65536
const LOCAL_PAD = 4096
const MERGE_GAP = 65536
const RANGE_CONCURRENCY = 4

const isDirectory = path => path.endsWith("/")

export function isData(path, legacyLayout) {
  if (isDirectory(path)) return false
  if (legacyLayout) return !path.endsWith(".class") && !path.startsWith("META-INF/")
  if (path.startsWith("assets/") || path.startsWith("data/")) return !path.endsWith("/.mcassetsroot")
  return path === "pack.png" || path === "pack.mcmeta" || path === "version.json"
}

export class Jar {
  constructor({ url, size, sha1, legacyLayout, request, store }) {
    this.url = url
    this.size = size
    this.sha1 = sha1
    this.legacyLayout = legacyLayout
    this.request = request
    this.store = store
    this._listing = null
    this._buffer = null
    this._persisted = null
    this._progress = null
    this._reads = new Map()
  }

  get metaKey() { return "jar_" + this.sha1 }
  get blobKey() { return "jar_" + this.sha1 }

  async _range(start, end, tick) {
    const res = await this.request(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } })
    const wanted = end - start
    if (res.status === 206 && tick && res.body) {
      const out = new Uint8Array(wanted)
      const reader = res.body.getReader()
      let at = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        out.set(value, at)
        at += value.length
        tick(value.length)
      }
      if (at === wanted) return out
      throw new Error(`Ranged request refused (206, ${at} bytes for ${wanted}) by ${this.url}`)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (res.status !== 206 || bytes.length !== wanted) throw new Error(`Ranged request refused (${res.status}, ${bytes.length} bytes for ${wanted}) by ${this.url}`)
    tick?.(wanted)
    return bytes
  }

  listing() {
    return memo(this, "_listing", () => this._loadListing())
  }

  async _loadListing() {
    const cached = await this.store.get("meta", this.metaKey)
    if (cached?.entries && cached.size === this.size) return this._inflateListing(cached)
    if (this._buffer) {
      const chunks = await this._buffer.catch(() => null)
      if (chunks) return this._listingFromZip(this._parseTail(chunks[chunks.length - 1]))
    }
    return this._probe()
  }

  _parseTail(chunk) {
    const at = findEocd(chunk.bytes)
    if (at < 0) throw new Error("No zip end record found in " + this.url)
    const eocd = parseEocd(chunk.bytes, at)
    return { ...eocd, entries: parseCentralDirectory(chunk.bytes.subarray(eocd.cdOffset - chunk.start, eocd.cdOffset - chunk.start + eocd.cdSize)) }
  }

  _inflateListing({ entries, cdOffset, cdSize }) {
    const map = new Map()
    for (const [path, offset, compressedSize, size, method, crc] of entries) {
      map.set(path, { path, offset, compressedSize, size, method, crc })
    }
    return { entries: map, cdOffset, cdSize }
  }

  async _listingFromZip({ entries, cdOffset, cdSize }) {
    const map = new Map()
    for (const e of entries) if (isData(e.path, this.legacyLayout)) map.set(e.path, e)
    const listing = { entries: map, cdOffset, cdSize }
    await this.store.set("meta", this.metaKey, {
      size: this.size,
      cdOffset,
      cdSize,
      entries: [...map.values()].map(e => [e.path, e.offset, e.compressedSize, e.size, e.method, e.crc])
    })
    return listing
  }

  async _probe() {
    const tailStart = Math.max(0, this.size - TAIL_PROBE)
    const tail = await this._range(tailStart, this.size)
    const at = findEocd(tail)
    if (at < 0) throw new Error("No zip end record found in " + this.url)
    const eocd = parseEocd(tail, at)
    const cd = eocd.cdOffset >= tailStart
      ? tail.subarray(eocd.cdOffset - tailStart, eocd.cdOffset - tailStart + eocd.cdSize)
      : await this._range(eocd.cdOffset, eocd.cdOffset + eocd.cdSize)
    return this._listingFromZip({ ...eocd, entries: parseCentralDirectory(cd) })
  }

  buffer() {
    return memo(this, "_buffer", () => this._loadBuffer())
  }

  async _loadBuffer() {
    const packed = await this.store.get("blobs", this.blobKey)
    if (packed) {
      try {
        const buf = await inflateRaw(packed)
        if (buf.length === this.size) return this._compact(buf)
      } catch {}
    }
    const { entries, cdOffset } = await this.listing()
    const ranges = [...entries.values()].map(e => this._entryRange(e))
    ranges.push([cdOffset, this.size])
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
    chunks.sort((a, b) => a.start - b.start)
    this._persisted = this._persist(chunks)
    return chunks
  }

  async load(onProgress) {
    this._progress = onProgress
    try {
      await this.listing()
      const chunks = await this.buffer()
      if (onProgress) {
        const total = chunks.reduce((n, c) => n + c.bytes.length, 0)
        onProgress(total, total)
      }
    } finally {
      this._progress = null
    }
  }

  _compact(buf) {
    const at = findEocd(buf)
    if (at < 0) throw new Error("Not a zip file")
    const eocd = parseEocd(buf, at)
    const data = parseCentralDirectory(buf.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize)).filter(e => isData(e.path, this.legacyLayout))
    const ranges = data.map(e => this._entryRange(e))
    ranges.push([eocd.cdOffset, this.size])
    return mergeRanges(ranges, MERGE_GAP).map(([start, end]) => ({ start, bytes: buf.slice(start, end) }))
  }

  async _persist(chunks) {
    try {
      const buf = new Uint8Array(this.size)
      for (const c of chunks) buf.set(c.bytes, c.start)
      await this.store.set("blobs", this.blobKey, await deflateRaw(buf, 1))
    } catch {}
  }

  _entryRange(e) {
    const end = e.offset + 30 + (e.nameLen ?? encoder.encode(e.path).length) + e.compressedSize + LOCAL_PAD
    return [e.offset, Math.min(this.size, end)]
  }

  async raw(path) {
    const { entries } = await this.listing()
    const entry = entries.get(path)
    if (!entry) return null
    const chunks = await this.buffer()
    const chunk = chunks.findLast(c => c.start <= entry.offset)
    return { entry, data: rawFromBuffer(chunk.bytes, { ...entry, offset: entry.offset - chunk.start }) }
  }

  async extract(path) {
    const hit = await this.raw(path)
    return hit ? decodeEntry(hit.data, hit.entry) : null
  }

  read(path) {
    let p = this._reads.get(path)
    if (!p) {
      p = this.extract(path)
      this._reads.set(path, p)
      p.catch(() => { if (this._reads.get(path) === p) this._reads.delete(path) })
    }
    return p
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
