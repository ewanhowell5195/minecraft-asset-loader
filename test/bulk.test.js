// Live bulk paths: loadObjects, export, the sparse jar transport, offline.
// Subtests here are order-dependent (they build up a warm cache, then cut the network).

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import MinecraftAssets from "../src/index.js"
import { listBuffer, entryFromBuffer, inflateRaw } from "../src/zip.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "bulk")
const OUT = path.join(os.tmpdir(), "minecraft-assets-tests", "bulk-out")

const real = globalThis.fetch
let requests = []
globalThis.fetch = (url, init) => {
  requests.push({ url: String(url), range: init?.headers?.Range })
  return real(url, init)
}
const jarRequests = () => requests.filter(r => r.url.includes("client.jar"))

const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })

test("loadObjects: predicate, array of entries, array of strings", async () => {
  let ticks = 0
  const notes = await mc.loadObjects({ filter: p => p.includes("/sounds/note/"), onProgress: (done, total) => { ticks++; assert.ok(done <= total) } })
  assert.equal(notes.size, 18)
  assert.equal(ticks, 18)
  assert.ok([...notes.keys()].every(p => p.startsWith("assets/minecraft/sounds/note/")))
  assert.equal(notes.get("assets/minecraft/sounds/note/harp.ogg").length, 6137)

  const picked = await mc.search("harp", { extension: "ogg", objects: true })
  const byEntries = await mc.loadObjects({ filter: picked })
  assert.equal(byEntries.size, picked.length)

  const one = await mc.loadObjects({ filter: ["assets/minecraft/sounds/note/pling.ogg"] })
  assert.equal(one.size, 1)
})

test("loadObjects: bytes match listing sizes and warm the store", async () => {
  const listed = new Map((await mc.list({ objects: true })).filter(f => f.path.includes("/sounds/note/")).map(f => [f.path, f.size]))
  const loaded = await mc.loadObjects({ filter: p => p.includes("/sounds/note/") })
  for (const [p, bytes] of loaded) assert.equal(bytes.length, listed.get(p), p)

  const blobs = await fs.readdir(path.join(CACHE, "blobs"))
  assert.ok(blobs.length >= 18, "objects cached by hash")
})

test("loadObjects cache: false touches nothing", async () => {
  const store = new Map()
  const spy = { read: k => store.get(k), write: (k, d) => store.set(k, d) }
  const mc2 = new MinecraftAssets({ cacheAPI: spy, version: "1.21.4" })
  const map = await mc2.loadObjects({ filter: ["assets/minecraft/sounds/note/pling.ogg"], cache: false })
  assert.equal(map.size, 1)
  assert.ok(![...store.keys()].some(k => k.startsWith("blobs/") && !k.startsWith("blobs/jar_")), "no object blobs written")
})

test("first content read fetches a minimal jar, not the whole thing", async () => {
  // A cold cache on purpose: the shared one may be warm from a previous run.
  const COLD = path.join(os.tmpdir(), "minecraft-assets-tests", "bulk-cold")
  await fs.rm(COLD, { recursive: true, force: true })
  const cold = new MinecraftAssets({ cacheDir: COLD, version: "1.21.4" })

  requests = []
  const bytes = await cold.read("assets/minecraft/textures/block/stone.png")
  assert.equal(bytes.length, 157)
  const jarReqs = jarRequests()
  assert.ok(jarReqs.length > 0)
  assert.ok(jarReqs.every(r => r.range), "everything ranged, never a full GET")

  requests = []
  await cold.read("assets/minecraft/models/block/stone.json")
  await cold.read("assets/minecraft/shaders/core/position.json")
  assert.equal(jarRequests().length, 0, "later reads are in-memory slices")
  await fs.rm(COLD, { recursive: true, force: true })
})

test("loadJar: forces the download with byte progress", async () => {
  const COLD = path.join(os.tmpdir(), "minecraft-assets-tests", "bulk-loadjar")
  await fs.rm(COLD, { recursive: true, force: true })
  const cold = new MinecraftAssets({ cacheDir: COLD, version: "1.21.4" })

  const ticks = []
  await cold.loadJar({ onProgress: (done, total) => ticks.push([done, total]) })
  assert.ok(ticks.length > 10, "progress streams within ranges")
  assert.ok(ticks.every(([done, total]) => done <= total && total > 5_000_000))
  assert.equal(ticks.at(-1)[0], ticks.at(-1)[1], "ends complete")
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i][0] >= ticks[i - 1][0], "monotonic")

  requests = []
  assert.equal((await cold.read("assets/minecraft/textures/block/stone.png")).length, 157)
  assert.equal(jarRequests().length, 0, "reads after loadJar cost nothing")

  const again = []
  await cold.loadJar({ onProgress: (done, total) => again.push([done, total]) })
  assert.equal(again.length, 1, "already loaded reports complete once")
  assert.equal(again[0][0], again[0][1])
  await fs.rm(COLD, { recursive: true, force: true })
})

test("the sparse jar caches compressed, and covers later selections", async () => {
  await mc.read("assets/minecraft/textures/block/stone.png")
  await new Promise(r => setTimeout(r, 800))
  const details = await mc.manifest.details("1.21.4")
  const sha1 = details.downloads.client.sha1
  const packed = await fs.readFile(path.join(CACHE, "blobs", "jar_" + sha1))
  assert.ok(packed.length < details.downloads.client.size / 3, "holes deflate away")
  const sparse = await inflateRaw(new Uint8Array(packed))
  assert.equal(sparse.length, details.downloads.client.size, "full-size sparse buffer")

  requests = []
  const zip = await mc.export({ filter: p => p.includes("/models/block/") })
  assert.ok(listBuffer(zip).length > 1000)
  assert.equal(jarRequests().length, 0, "export served from the cached sparse jar")
})

test("export: zip contents match direct reads", async () => {
  const zip = await mc.export({ filter: p => p.includes("note_block") })
  const entries = listBuffer(zip)
  assert.equal(entries.length, 8)
  const one = entries.find(e => e.path === "assets/minecraft/textures/block/note_block.png")
  const bytes = await entryFromBuffer(zip, one)
  const direct = await mc.read(one.path)
  assert.deepEqual(Array.from(bytes), Array.from(direct))
})

test("export: folder tree on disk, objects flag, filter forms", async () => {
  await fs.rm(OUT, { recursive: true, force: true })
  const n = await mc.export({ dir: OUT, filter: p => p.includes("note_block") })
  assert.equal(n, 8)
  const onDisk = await fs.readFile(path.join(OUT, "assets/minecraft/textures/block/note_block.png"))
  assert.deepEqual(Array.from(onDisk), Array.from(await mc.read("assets/minecraft/textures/block/note_block.png")))
  await fs.rm(OUT, { recursive: true, force: true })

  const mixed = await mc.export({ objects: true, filter: p => p.includes("/note/") || p.includes("note_block.png") })
  const paths = listBuffer(mixed).map(e => e.path)
  assert.ok(paths.some(p => p.includes("/sounds/note/")) && paths.some(p => p.includes("/textures/")))

  const byArray = await mc.export({ filter: ["assets/minecraft/textures/block/note_block.png"] })
  assert.equal(listBuffer(byArray).length, 1)
})

test("export: a whole old version is pure data, no code", async () => {
  const zip = await mc.export({ version: "b1.7.3" })
  const paths = listBuffer(zip).map(e => e.path)
  assert.ok(paths.length > 80)
  assert.ok(!paths.some(p => p.endsWith(".class") || p.startsWith("META-INF/")))
  assert.ok(paths.some(p => p.endsWith(".png")))
})

test("code is unreachable: unlisted, and read comes back null", async () => {
  assert.equal(await mc.read("net/minecraft/client/main/Main.class"), null)
  assert.ok(!(await mc.list()).some(f => f.path.endsWith(".class")))
})

test("fully offline from a warm cache with a provided manifest", async () => {
  const manifest = { versions: await mc.manifest.versions() }
  globalThis.fetch = async url => { throw new Error("OFFLINE: " + url) }
  try {
    const off = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4", manifest })
    assert.ok((await off.list()).length > 15000)
    assert.equal((await off.read("assets/minecraft/textures/block/stone.png")).length, 157)
    assert.equal((await off.getSound("note/harp")).length, 6137)
    assert.ok((await off.search("stone", { extension: "png", limit: 1 })).length === 1)
    const zip = await off.export({ filter: p => p.includes("note_block") })
    assert.equal(listBuffer(zip).length, 8)
    const notes = await off.loadObjects({ filter: p => p.includes("/sounds/note/") })
    assert.equal(notes.size, 18)
    await assert.rejects(() => off.read("particles.png", { version: "1.5.2" }), /OFFLINE/, "an uncached version still needs the network")
  } finally {
    globalThis.fetch = real
  }
})
