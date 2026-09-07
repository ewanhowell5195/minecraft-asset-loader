import zlib from "node:zlib"
import { promisify } from "node:util"

const inflate = promisify(zlib.inflateRaw)
const deflate = promisify(zlib.deflateRaw)

const plain = buf => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

export async function inflateRaw(bytes) {
  return plain(await inflate(bytes, { chunkSize: 1 << 20 }))
}

export async function deflateRaw(bytes, level) {
  return plain(await deflate(bytes, { level: level ?? zlib.constants.Z_DEFAULT_COMPRESSION, chunkSize: 1 << 20 }))
}
