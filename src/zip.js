import { isNode, encoder, decoder, define, pool } from "./util.js"

export const SIG_LOCAL = 0x04034b50
export const SIG_CENTRAL = 0x02014b50
export const SIG_EOCD = 0x06054b50

const u16 = (b, i) => b[i] | (b[i + 1] << 8)
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const u64 = (b, i) => u32(b, i) + u32(b, i + 4) * 0x100000000

let nodeZlib
const zlib = () => nodeZlib ??= import("./zlib-node.js")

async function transform(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export async function inflateRaw(bytes) {
  if (isNode) return (await zlib()).inflateRaw(bytes)
  return transform(bytes, new DecompressionStream("deflate-raw"))
}

export async function deflateRaw(bytes, level) {
  if (isNode) return (await zlib()).deflateRaw(bytes, level)
  return transform(bytes, new CompressionStream("deflate-raw"))
}

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

export function crc32(bytes) {
  let c = -1
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) if (u32(buf, i) === SIG_EOCD) return i
  return -1
}

export function parseEocd(buf, at) {
  return { count: u16(buf, at + 10), cdSize: u32(buf, at + 12), cdOffset: u32(buf, at + 16) }
}

export function parseCentralDirectory(cd) {
  const entries = []
  let i = 0
  while (i + 46 <= cd.length && u32(cd, i) === SIG_CENTRAL) {
    const nameLen = u16(cd, i + 28)
    const extraLen = u16(cd, i + 30)
    const commentLen = u16(cd, i + 32)
    const entry = {
      path: decoder.decode(cd.subarray(i + 46, i + 46 + nameLen)),
      method: u16(cd, i + 10),
      crc: u32(cd, i + 16),
      compressedSize: u32(cd, i + 20),
      size: u32(cd, i + 24),
      offset: u32(cd, i + 42),
      nameLen
    }
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.offset === 0xffffffff) {
      let at = i + 46 + nameLen
      const end = at + extraLen
      while (at + 4 <= end) {
        const id = u16(cd, at)
        const len = u16(cd, at + 2)
        if (id === 1) {
          let field = at + 4
          if (entry.size === 0xffffffff) {
            entry.size = u64(cd, field)
            field += 8
          }
          if (entry.compressedSize === 0xffffffff) {
            entry.compressedSize = u64(cd, field)
            field += 8
          }
          if (entry.offset === 0xffffffff) entry.offset = u64(cd, field)
          break
        }
        at += 4 + len
      }
    }
    entries.push(entry)
    i += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function parseZip(buf) {
  const at = findEocd(buf)
  if (at < 0) throw new Error("Not a zip file")
  let eocd = parseEocd(buf, at)
  if ((eocd.count === 0xffff || eocd.cdSize === 0xffffffff || eocd.cdOffset === 0xffffffff) && at >= 20 && u32(buf, at - 20) === 0x07064b50) {
    const at64 = u64(buf, at - 12)
    if (at64 + 56 <= buf.length && u32(buf, at64) === 0x06064b50) {
      eocd = { count: u64(buf, at64 + 32), cdSize: u64(buf, at64 + 40), cdOffset: u64(buf, at64 + 48) }
    }
  }
  return { ...eocd, entries: parseCentralDirectory(buf.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize)) }
}

export function listBuffer(buf) {
  return parseZip(buf).entries
}

export function localDataOffset(buf, entry) {
  const o = entry.offset
  return o + 30 + u16(buf, o + 26) + u16(buf, o + 28)
}

export function rawFromBuffer(buf, entry) {
  const at = localDataOffset(buf, entry)
  return buf.subarray(at, at + entry.compressedSize)
}

export async function decodeEntry(raw, entry) {
  return entry.method === 0 ? raw.slice() : inflateRaw(raw)
}

export function entryFromBuffer(buf, entry) {
  return decodeEntry(rawFromBuffer(buf, entry), entry)
}

const DOS_TIME = 0
const DOS_DATE = 0x21

export function buildZip(items) {
  if (items.length > 0xffff) throw new Error("Too many entries for a plain zip")
  const parts = []
  const centrals = []
  let offset = 0
  for (const it of items) {
    const name = encoder.encode(it.path)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, SIG_LOCAL, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, it.method, true)
    lv.setUint16(10, DOS_TIME, true)
    lv.setUint16(12, DOS_DATE, true)
    lv.setUint32(14, it.crc, true)
    lv.setUint32(18, it.compressedSize, true)
    lv.setUint32(22, it.size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, SIG_CENTRAL, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, it.method, true)
    cv.setUint16(12, DOS_TIME, true)
    cv.setUint16(14, DOS_DATE, true)
    cv.setUint32(16, it.crc, true)
    cv.setUint32(20, it.compressedSize, true)
    cv.setUint32(24, it.size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    parts.push(local, it.data)
    centrals.push(central)
    offset += local.length + it.data.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  if (offset + cdSize > 0xffffffff) throw new Error("Archive too large for a plain zip")
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(8, items.length, true)
  ev.setUint16(10, items.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + cdSize + 22)
  let at = 0
  for (const p of [...parts, ...centrals, eocd]) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export async function packEntry(path, bytes, compress = true) {
  const crc = crc32(bytes)
  let data = bytes
  let method = 0
  if (compress && bytes.length > 0) {
    const packed = await deflateRaw(bytes)
    if (packed.length < bytes.length) {
      data = packed
      method = 8
    }
  }
  return { path, method, crc, size: bytes.length, compressedSize: data.length, data }
}

export function readZip(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return parseZip(buf).entries.filter(e => !e.path.endsWith("/")).map(entry => {
    const out = { path: entry.path, size: entry.size, crc: entry.crc }
    let memo
    define(out, "read", () => memo ??= entryFromBuffer(buf, entry))
    define(out, "raw", async () => ({ compression: entry.method === 8 ? "deflate-raw" : null, bytes: rawFromBuffer(buf, entry) }))
    return out
  })
}

export async function writeZip(files, { compress = true, concurrency = 32, onProgress } = {}) {
  const list = files instanceof Map ? [...files]
    : Array.isArray(files) ? files.map(f => [f.path, f])
    : Object.entries(files)
  const items = new Array(list.length)
  let done = 0
  await pool(list, concurrency, async ([path, data], i) => {
    items[i] = await packEntry(path, data instanceof Uint8Array ? data : await data.read(), compress)
    onProgress?.(++done, list.length)
  })
  return buildZip(items)
}
