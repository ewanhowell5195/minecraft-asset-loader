// A jar whose entries cross the boundary between the ranged chunks and the tail chunk must still read back whole.

import test from "node:test"
import assert from "node:assert/strict"
import MinecraftAssets, { writeZip } from "../src/index.js"
import { findEocd, parseEocd, parseCentralDirectory } from "../src/zip.js"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const JAR = "https://piston-data.mojang.com/v1/objects/abc/client.jar"

const files = {}
for (let i = 0; i < 400; i++) {
  files[`assets/minecraft/models/block/m${i}.json`] = new TextEncoder().encode(JSON.stringify({ parent: "block/cube_all", index: i, textures: { all: "block/stone_" + i, side: "block/side_" + i } }, null, 2))
}
const zip = await writeZip(files)

function tailStart(size) {
  return Math.max(0, size - Math.min(4 << 20, Math.max(65536, Math.round(size / 10))))
}

function serve(url, init) {
  const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } })
  if (url === MANIFEST) return json({ versions: [{ id: "t1", type: "release", releaseTime: "2026-01-01T00:00:00Z", url: "https://piston-meta.mojang.com/v1/packages/aaaaaaaaaa/1.json" }] })
  if (url.includes("/packages/aaaaaaaaaa/")) return json({
    id: "t1",
    downloads: { client: { url: JAR, sha1: "deadbeef", size: zip.length } },
    assetIndex: { id: "t", sha1: "b".repeat(40), size: 10, totalSize: 8, url: "https://piston-meta.mojang.com/v1/packages/bbbbbbbbbb/t.json" }
  })
  if (url.includes("/packages/bbbbbbbbbb/")) return json({ objects: {} })
  if (url === JAR) {
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")
    if (m) return new Response(zip.slice(+m[1], +m[2] + 1), { status: 206 })
    return new Response(zip)
  }
  throw new Error("unexpected url: " + url)
}

test("entries straddling the tail chunk boundary read back whole", async () => {
  const boundary = tailStart(zip.length)
  const eocd = parseEocd(zip, findEocd(zip))
  const entries = parseCentralDirectory(zip.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize))
  const view = new DataView(zip.buffer, zip.byteOffset)
  const straddling = entries.filter(e => {
    const dataEnd = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true) + e.compressedSize
    return e.offset < boundary && dataEnd > boundary
  })
  assert.ok(straddling.length > 0, "the fixture has an entry crossing the tail boundary")

  globalThis.fetch = (url, init) => serve(String(url), init)
  const mc = new MinecraftAssets({ version: "t1", cacheAPI: {} })
  const listed = await mc.list()
  assert.equal(listed.length, 400)

  for (const entry of listed) {
    const bytes = await mc.read(entry.path)
    assert.deepEqual(bytes, files[entry.path], entry.path)
    const raw = await entry.raw()
    assert.equal(raw.bytes.length, entries.find(e => e.path === entry.path).compressedSize, entry.path + " raw length")
  }
})
