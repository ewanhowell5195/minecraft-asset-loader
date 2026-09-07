// Proxying against a fully mocked Mojang: everything routed, applied exactly once.

import test from "node:test"
import assert from "node:assert/strict"
import MinecraftAssets from "../src/index.js"
import { listBuffer } from "../src/zip.js"

const enc = new TextEncoder()

// A real stored zip built by hand: entries under assets/ so the minimal floor keeps them.
function mkZip(entries) {
  const chunks = [], central = []
  let offset = 0
  for (const [name, data] of entries) {
    const n = enc.encode(name)
    const local = new Uint8Array(30 + n.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(26, n.length, true)
    local.set(n, 30)
    chunks.push(local, data)
    const cd = new Uint8Array(46 + n.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, n.length, true)
    cv.setUint32(42, offset, true)
    cd.set(n, 46)
    central.push(cd)
    offset += local.length + data.length
  }
  const dirBytes = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, dirBytes, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + dirBytes + 22)
  let at = 0
  for (const c of [...chunks, ...central, eocd]) { out.set(c, at); at += c.length }
  return out
}

const zip = mkZip([
  ["assets/minecraft/textures/wanted.png", enc.encode("proxied png bytes")],
  ["net/x.class", enc.encode("code")]
])

const JAR = "https://piston-data.mojang.com/v1/objects/abc/client.jar"
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const OBJ = "https://resources.download.minecraft.net/aa/aabbccdd"

function serve(rawUrl, init) {
  const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } })
  if (rawUrl === MANIFEST) return json({ versions: [{ id: "t1", type: "release", releaseTime: "2026-01-01T00:00:00Z", url: "https://piston-meta.mojang.com/v1/packages/aaaaaaaaaa/1.json" }] })
  if (rawUrl.includes("/packages/aaaaaaaaaa/")) return json({
    id: "t1",
    downloads: { client: { url: JAR, sha1: "deadbeef", size: zip.length } },
    assetIndex: { id: "t", sha1: "b".repeat(40), size: 10, totalSize: 8, url: "https://piston-meta.mojang.com/v1/packages/bbbbbbbbbb/t.json" }
  })
  if (rawUrl.includes("/packages/bbbbbbbbbb/")) return json({ objects: { "minecraft/sounds/x.ogg": { hash: "aabbccdd", size: 8 } } })
  if (rawUrl === OBJ) return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  if (rawUrl === JAR) {
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")
    if (m) return new Response(zip.slice(+m[1], +m[2] + 1), { status: 206 })
    return new Response(zip)
  }
  throw new Error("unexpected url: " + rawUrl)
}

test("prefix proxy: every request routed, prefixed exactly once", async () => {
  const seen = []
  globalThis.fetch = (url, init) => {
    const u = String(url)
    seen.push(u)
    assert.ok(u.startsWith("https://p/"), "unproxied request: " + u)
    assert.ok(!u.slice(10).startsWith("https://p/"), "double proxied: " + u)
    return serve(u.slice(10), init)
  }

  const mc = new MinecraftAssets({ proxy: "https://p/", version: "t1", cacheAPI: {} })
  const files = await mc.list({ objects: true })
  assert.equal(files.length, 2)
  assert.equal(new TextDecoder().decode(await mc.read("assets/minecraft/textures/wanted.png")), "proxied png bytes")
  assert.deepEqual(Array.from(await mc.read("assets/minecraft/sounds/x.ogg", { objects: true })), [1, 2, 3, 4, 5, 6, 7, 8])
  const zipOut = await mc.export({ filter: () => true })
  assert.equal(listBuffer(zipOut).length, 1, "export excludes code")
  assert.ok(seen.length >= 5)
})

test("function proxy: per-url routing, falsy means direct", async () => {
  const direct = []
  const proxied = []
  globalThis.fetch = (url, init) => {
    const u = String(url)
    if (u.startsWith("https://p/")) {
      proxied.push(u)
      return serve(u.slice(10), init)
    }
    direct.push(u)
    return serve(u, init)
  }

  const mc = new MinecraftAssets({
    proxy: u => u.includes("piston-meta") ? false : "https://p/" + u,
    version: "t1",
    cacheAPI: {}
  })
  await mc.read("assets/minecraft/textures/wanted.png")
  assert.ok(direct.every(u => u.includes("piston-meta")))
  assert.ok(direct.length >= 2, "exempted host went direct")
  assert.ok(proxied.every(u => u.slice(10).startsWith("https://piston-data")))
})
