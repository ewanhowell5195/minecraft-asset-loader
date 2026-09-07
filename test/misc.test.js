// Cross-cutting behaviour: the default version, concurrency, inheritance, entry bulk.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets from "../src/index.js"
import { listBuffer } from "../src/zip.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "misc")

test("setVersion changes the default, read at call time", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.8.9" })
  assert.ok((await mc.file("assets/minecraft/textures/blocks/stone.png"))?.size > 0)

  const entry = await mc.setVersion("1.21.4")
  assert.equal(entry.id, "1.21.4")
  assert.equal(await mc.file("assets/minecraft/textures/blocks/stone.png"), null)
  assert.equal((await mc.file("assets/minecraft/textures/block/stone.png")).size, 157)

  await mc.setVersion(null)
  const { release } = await mc.manifest.latest()
  const viaDefault = await mc.list()
  const viaExplicit = await mc.list({ version: release.id })
  assert.equal(viaDefault, viaExplicit, "unset falls back to the latest release")

  await assert.rejects(() => mc.setVersion("not-real"), /not-real/)
  assert.equal(mc.version, release.id, "a failed setVersion changes nothing")
})

test("version keywords: release, snapshot, newest", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE })
  assert.equal(mc.version, null, "nothing resolved before the manifest loads")
  assert.equal(mc.channel, null)
  const { release, snapshot, newest } = await mc.manifest.latest()
  assert.equal(mc.version, release.id, "reads back as the resolved id")
  assert.equal(mc.channel, "release")
  assert.equal(await mc.list(), await mc.list({ version: release.id }), "release is the default")
  assert.equal((await mc.manifest.details("snapshot")).id, snapshot.id)
  assert.equal((await mc.manifest.details("newest")).id, newest.id)
  assert.ok(newest === release || newest === snapshot)

  await mc.setVersion("snapshot")
  assert.equal(mc.version, snapshot.id)
  assert.equal(mc.channel, "snapshot")
  assert.equal(await mc.list(), await mc.list({ version: snapshot.id }), "keywords work as the default too")

  await mc.setVersion("newest")
  assert.equal(mc.version, newest.id)
  assert.equal(mc.channel, newest.type)

  await mc.setVersion("b1.7.3")
  assert.equal(mc.version, "b1.7.3")
  assert.equal(mc.channel, "old_beta")
})

test("concurrent identical calls share one result", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  const [a, b] = await Promise.all([mc.list(), mc.list()])
  assert.equal(a, b, "same array, not two builds")

  const f = await mc.file("assets/minecraft/textures/block/stone.png")
  const [x, y] = await Promise.all([f.read(), f.read()])
  assert.equal(x, y, "concurrent reads share one fetch")
})

test("folder entries inherit their objects context", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  const { folders } = await mc.list("assets/minecraft", { objects: true, folders: true })
  const sounds = folders.find(f => f.path.endsWith("/sounds"))
  const inside = await sounds.list()
  assert.ok(inside.length > 0, "folder entry list() is flat by default")
  assert.ok((await sounds.search("harp")).every(f => f.source === "object"), "search under an objects-on folder sees objects")

  const textures = folders.find(f => f.path.endsWith("/textures"))
  assert.equal(textures.source, "both")
  const jarOnly = await textures.list({ objects: false, folders: true })
  assert.ok(jarOnly.folders.every(f => f.source === "jar"), "objects can be overridden on a folder listing")
  assert.ok((await textures.list({ folders: true })).folders.some(f => f.source !== "jar"), "and the inherited context still holds")

  const plain = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  const root = (await plain.list("assets", { folders: true })).folders.find(f => f.path === "assets/minecraft")
  const gui = (await root.list({ objects: true, folders: true })).folders.find(f => f.path.endsWith("/textures"))
  const title = (await gui.list({ folders: true })).folders.find(f => f.path.endsWith("/gui"))
  assert.ok((await title.list({ folders: true })).folders.some(f => f.source !== "jar"), "an override carries down through every level below it")
})

test("version entries: loadObjects and export are bound too", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE })
  const v = await mc.manifest.version("1.21.4")
  const map = await v.loadObjects({ filter: ["assets/minecraft/sounds/note/pling.ogg"] })
  assert.equal(map.size, 1)
  const zip = await v.export({ filter: p => p.endsWith("block/stone.png") })
  assert.ok(listBuffer(zip).some(e => e.path === "assets/minecraft/textures/block/stone.png"))
})

test("independent instances do not share in-memory state", async () => {
  const a = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  const b = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  const fa = await a.file("assets/minecraft/textures/block/stone.png")
  const fb = await b.file("assets/minecraft/textures/block/stone.png")
  assert.notEqual(fa, fb, "each instance builds its own entries")
  assert.deepEqual(Array.from(await fa.read()), Array.from(await fb.read()), "but the bytes agree")
})

test("getters and reads never throw on absence, they return null", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  for (const p of [
    mc.read("assets/minecraft/nope.png"),
    mc.file("assets/minecraft/nope.png"),
    mc.getTexture("nope"),
    mc.getModel("nope"),
    mc.getBlockstate("nope"),
    mc.getItemDefinition("nope"),
    mc.getSound("nope"),
    mc.getStructure("nope"),
    mc.getLang("xx_xx")
  ]) {
    assert.equal(await p, null)
  }
})

test("readZip and writeZip: roundtrip, exports, file entries", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })
  const { readZip, writeZip } = await import("../src/index.js")

  const zip = await writeZip({ "a/b.txt": new TextEncoder().encode("hello"), "c.bin": new Uint8Array(1000) })
  const entries = readZip(zip)
  assert.deepEqual(entries.map(e => e.path), ["a/b.txt", "c.bin"])
  assert.equal(new TextDecoder().decode(await entries[0].read()), "hello")
  assert.equal(await entries[0].read(), await entries[0].read(), "read is memoised")
  assert.equal(typeof entries[0].crc, "number")
  assert.deepEqual(Object.keys(entries[0]), ["path", "size", "crc"])

  assert.deepEqual(readZip(await writeZip(entries)).map(e => e.crc), entries.map(e => e.crc), "readZip output repacks")

  const raw = await entries[0].raw()
  assert.ok(raw.compression === null || raw.compression === "deflate-raw")
  assert.ok(raw.bytes instanceof Uint8Array)

  const ticks = []
  const stored = await writeZip({ "a.txt": new TextEncoder().encode("hello hello hello hello") }, { compress: false, onProgress: (done, total) => ticks.push([done, total]) })
  assert.deepEqual(ticks, [[1, 1]], "progress counts packed files")
  assert.equal((await readZip(stored)[0].raw()).compression, null, "compress: false stores everything")

  const exported = await mc.export({ filter: p => p.includes("note_block") })
  assert.equal(readZip(exported).length, 8, "reads the library's own exports")

  const files = (await mc.list("assets/minecraft/models/block")).slice(0, 3)
  const packed = readZip(await writeZip(files))
  assert.deepEqual(packed.map(e => e.path), files.map(f => f.path), "file entries pack directly")
})

test("readZip: zip64 end record and extra fields", async () => {
  const { readZip } = await import("../src/index.js")
  const enc = new TextEncoder()
  const name = enc.encode("a.txt")
  const data = enc.encode("hi")
  const buf = new Uint8Array(214)
  const dv = new DataView(buf.buffer)

  dv.setUint32(0, 0x04034b50, true)
  dv.setUint16(8, 0, true)
  dv.setUint32(18, data.length, true)
  dv.setUint32(22, data.length, true)
  dv.setUint16(26, name.length, true)
  buf.set(name, 30)
  buf.set(data, 35)

  dv.setUint32(37, 0x02014b50, true)
  dv.setUint32(37 + 20, 0xffffffff, true)
  dv.setUint32(37 + 24, 0xffffffff, true)
  dv.setUint16(37 + 28, name.length, true)
  dv.setUint16(37 + 30, 28, true)
  dv.setUint32(37 + 42, 0xffffffff, true)
  buf.set(name, 37 + 46)
  dv.setUint16(88, 1, true)
  dv.setUint16(90, 24, true)
  dv.setBigUint64(92, 2n, true)
  dv.setBigUint64(100, 2n, true)
  dv.setBigUint64(108, 0n, true)

  dv.setUint32(116, 0x06064b50, true)
  dv.setBigUint64(116 + 4, 44n, true)
  dv.setBigUint64(116 + 32, 1n, true)
  dv.setBigUint64(116 + 40, 79n, true)
  dv.setBigUint64(116 + 48, 37n, true)

  dv.setUint32(172, 0x07064b50, true)
  dv.setBigUint64(172 + 8, 116n, true)
  dv.setUint32(172 + 16, 1, true)

  dv.setUint32(192, 0x06054b50, true)
  dv.setUint16(192 + 8, 0xffff, true)
  dv.setUint16(192 + 10, 0xffff, true)
  dv.setUint32(192 + 12, 0xffffffff, true)
  dv.setUint32(192 + 16, 0xffffffff, true)

  const entries = readZip(buf)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, "a.txt")
  assert.equal(entries[0].size, 2)
  assert.equal(new TextDecoder().decode(await entries[0].read()), "hi")
})

test("unknown versions throw with the version named", async () => {
  const mc = new MinecraftAssets({ cacheDir: CACHE })
  await assert.rejects(() => mc.list({ version: "not-real" }), /not-real/)
  await assert.rejects(() => mc.manifest.details("not-real"), /not-real/)
})
