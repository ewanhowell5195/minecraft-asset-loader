// Live file layer: listings, browsing, search, file, read, entries.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets from "../src/index.js"
import { inflateRaw } from "../src/zip.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "files")
const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })

const STONE = "assets/minecraft/textures/block/stone.png"
const PANORAMA = "assets/minecraft/textures/gui/title/background/panorama_0.png"
const HARP = "assets/minecraft/sounds/note/harp.ogg"

test("list(): the game's data, flat, sorted, code never listed", async () => {
  const files = await mc.list()
  assert.ok(files.length > 15000)
  assert.ok(files.every(f => f.source === "jar"), "objects off by default")
  assert.ok(!files.some(f => f.path.endsWith(".class")))
  assert.ok(!files.some(f => f.path.startsWith("META-INF/")))
  assert.ok(files.some(f => f.path === "version.json"))
  assert.ok(files.some(f => f.path === "pack.png"))
  for (let i = 1; i < 200; i++) assert.ok(files[i - 1].path.localeCompare(files[i].path) <= 0)
  assert.ok(Object.isFrozen(files), "the shared listing cannot be mutated from outside")
  assert.throws(() => files.reverse())
})

test("objects: opt-in per call, separate cached views", async () => {
  const withObjects = await mc.list({ objects: true })
  const without = await mc.list()
  assert.ok(withObjects.length > without.length)
  const harp = withObjects.find(f => f.path === HARP)
  assert.equal(harp.source, "object")
  assert.equal(harp.size, 6137)
  assert.equal(typeof harp.hash, "string")
  assert.ok(!("crc" in harp), "crc is jar-only, objects have hash")
  assert.ok(!without.some(f => f.path === HARP))
})

test("constructor objects: true flips the default, per-call off overrides", async () => {
  const mc2 = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4", objects: true })
  assert.ok((await mc2.list()).some(f => f.source === "object"))
  assert.ok((await mc2.list({ objects: false })).every(f => f.source === "jar"))
})

test("file entries: pure data plus read(), memoised", async () => {
  const files = await mc.list()
  const stone = files.find(f => f.path === STONE)
  assert.deepEqual(Object.keys(stone), ["path", "source", "size", "crc"])
  assert.equal(typeof stone.crc, "number")
  assert.equal(stone.size, 157)
  assert.ok(!JSON.stringify(stone).includes("offset"))

  const a = await stone.read()
  const b = await stone.read()
  assert.equal(a.length, 157)
  assert.equal(a, b, "repeat read is the same buffer")

  const { compression, bytes } = await stone.raw()
  const plain = compression === "deflate-raw" ? await inflateRaw(bytes) : bytes
  assert.deepEqual(Array.from(plain), Array.from(a), "raw bytes decompress to the read bytes")
})

test("file(): the single-entry lookup, identity-shared with the listing", async () => {
  const f = await mc.file(STONE)
  assert.equal(f.size, 157)
  assert.ok((await mc.list()).includes(f))
  assert.equal(await mc.file("assets/minecraft/nope.png"), null)

  assert.equal(await mc.file(HARP), null, "object paths need objects on")
  assert.equal((await mc.file(HARP, { objects: true })).size, 6137)
})

test("read(): path, entry, datapack side, miss", async () => {
  assert.equal((await mc.read(STONE)).length, 157)
  assert.equal((await mc.read(await mc.file(STONE))).length, 157)
  const loot = await mc.read("data/minecraft/loot_table/blocks/stone.json")
  assert.equal(JSON.parse(new TextDecoder().decode(loot)).type, "minecraft:block")
  assert.equal(await mc.read("assets/minecraft/nope.png"), null)
})

test("collisions: object wins, prefer: 'jar' takes the stub", async () => {
  const pano = (await mc.list({ objects: true })).find(f => f.path === PANORAMA)
  assert.equal(pano.source, "object")
  const real = await pano.read()
  assert.ok(real.length > 100000)
  const stub = await pano.read({ prefer: "jar" })
  assert.equal(stub.length, 69)
  const back = await pano.read()
  assert.equal(back.length, real.length, "memo replaced correctly after the override")
})

test("browse: folder entries with aggregated source", async () => {
  const { files, folders } = await mc.list("assets/minecraft", { objects: true, folders: true })
  assert.ok(files.some(f => f.path.endsWith("sounds.json")))
  const by = Object.fromEntries(folders.map(f => [f.path.split("/").pop(), f]))
  assert.equal(by.sounds.source, "object")
  assert.equal(by.models.source, "jar")
  assert.equal(by.textures.source, "both")
  assert.deepEqual(Object.keys(by.sounds), ["path", "source", "objects"])
  assert.equal(by.sounds.objects, true, "folders carry the objects setting they were listed with")
})

test("browse: trailing slashes, folder entries feed back in", async () => {
  const a = await mc.list("assets/minecraft/textures", { folders: true })
  const b = await mc.list("assets/minecraft/textures/", { folders: true })
  assert.equal(a.folders.length, 14)
  assert.equal(b.folders.length, 14)
  const viaEntry = await mc.list(a.folders.find(f => f.path.endsWith("/block")), { folders: true })
  assert.ok(viaEntry.files.length > 1000)

  const flat = await mc.list("assets/minecraft/textures/block")
  assert.ok(Array.isArray(flat) && flat.length > 1000, "without folders: true a folder lists flat")
  assert.ok(flat.every(f => f.path.startsWith("assets/minecraft/textures/block/")))
  assert.ok((await mc.list()).includes(flat[0]), "scoped entries are the listing's own")
})

test("folder methods: list, search scoped, file and read relative", async () => {
  const { folders } = await mc.list("assets/minecraft", { folders: true })
  const tex = folders.find(f => f.path.endsWith("/textures"))

  const hits = await tex.search("stone", { extension: "png" })
  assert.ok(hits.length > 0)
  assert.ok(hits.every(h => h.path.startsWith(tex.path + "/")))

  const f = await tex.file("block/stone.png")
  assert.equal(f.size, 157)
  assert.equal((await tex.file(tex.path + "/block/stone.png")).size, 157, "full paths pass through")
  assert.equal((await tex.read("block/stone.png")).length, 157)
  assert.equal((await tex.read(f)).length, 157)

  const block = (await tex.list({ folders: true })).folders.find(x => x.path.endsWith("/block"))
  assert.equal((await block.read("stone.png")).length, 157, "descended folders carry them too")

  const scoped = await tex.list("/block")
  assert.ok(scoped.length > 1000, "folder list takes a relative subfolder, like the main method")
  assert.ok(scoped.every(f => f.path.startsWith("assets/minecraft/textures/block/")))
  assert.ok((await tex.list("block", { folders: true })).files.length > 1000, "browse form too")
  assert.deepEqual(await tex.list(block), scoped, "a child folder entry passes through")
})

test("search: ranking, tiers, and results share listing identity", async () => {
  const hits = await mc.search("stone", { extension: "png" })
  assert.ok(hits[0].path.endsWith("/stone.png"))
  const names = hits.map(h => h.path.split("/").pop().replace(".png", ""))
  const firstNonPrefix = names.findIndex(n => !n.startsWith("stone"))
  assert.ok(firstNonPrefix > 0)
  assert.ok(names.slice(firstNonPrefix).every(n => !n.startsWith("stone")), "two clean tiers")
  assert.ok((await mc.list()).includes(hits[0]), "results are the listing's own entries")
})

test("search: extension forms, root, path, filter, limit", async () => {
  const dotted = await mc.search("stone", { extension: ".png", limit: 5 })
  const bare = await mc.search("stone", { extension: "png", limit: 5 })
  assert.deepEqual(dotted.map(f => f.path), bare.map(f => f.path))

  const multi = await mc.search("stone", { extension: ["png", "json"], limit: 50 })
  assert.ok(multi.some(f => f.path.endsWith(".png")) && multi.some(f => f.path.endsWith(".json")))

  const rooted = await mc.search("stone", { root: "assets/minecraft/textures/block" })
  assert.ok(rooted.length > 0)
  assert.ok(rooted.every(f => f.path.startsWith("assets/minecraft/textures/block/")))

  const through = await mc.search("stone", { path: "block" })
  assert.ok(through.length > 0)
  assert.ok(through.every(f => f.path.includes("/block/")), "path means through these folders, wherever they sit")
  assert.ok(through.some(f => !f.path.startsWith("assets/minecraft/textures/block/")), "not only the textures one")

  const filtered = await mc.search("stone", { extension: "png", filter: p => typeof p === "string" && p.includes("/block/") })
  assert.ok(filtered.length > 0)
  assert.ok(filtered.every(f => f.path.includes("/block/")), "filter is given the path, like the bulk methods")

  assert.equal((await mc.search("stone", { limit: 3 })).length, 3)
})

test("search: query normalisation forgives how people type", async () => {
  const canonical = (await mc.search("stone", { extension: "png", limit: 1 }))[0]
  for (const q of ["Stone", "minecraft:stone", "stone.png", "block\\stone", "assets/minecraft/textures/block/stone.png"]) {
    assert.equal((await mc.search(q, { extension: "png", limit: 1 }))[0], canonical, q)
  }
  assert.equal((await mc.search("stone axe", { extension: "png", limit: 1 }))[0].path, "assets/minecraft/textures/item/stone_axe.png", "spaces mean underscores")
})

test("search: path-search-sort options pass through", async () => {
  const numbered = await mc.search(/fire_\d/, { extension: "png" })
  assert.ok(numbered.length > 0)
  assert.ok(numbered.every(f => /fire_\d/.test(f.path)), "a RegExp query")

  const inFolder = await mc.search("block", { root: "assets/minecraft/models" })
  assert.ok(inFolder.some(f => f.path.startsWith("assets/minecraft/models/block/") && !f.path.split("/").pop().includes("block")), "folder names match by default, reaching files inside a matching folder")
  assert.ok((await mc.search("block", { folders: false, root: "assets/minecraft/models" })).every(f => f.path.split("/").pop().includes("block")), "folders: false narrows to file names")

  assert.equal((await mc.search("Stone", { caseSensitive: true, extension: "png" })).length, 0)
})

test("search: empty query with a root is a prefix listing", async () => {
  const all = await mc.search("", { root: "assets/minecraft/models/block" })
  const manual = (await mc.list()).filter(f => f.path.startsWith("assets/minecraft/models/block/"))
  assert.equal(all.length, manual.length)
})

test("version option: per call, and silently ignored on entry-bound calls", async () => {
  const old = await mc.list({ version: "1.8.9" })
  assert.ok(old.length < 5000)
  assert.ok(old.some(f => f.path === "assets/minecraft/textures/blocks/stone.png"))

  const v = await mc.manifest.version("1.21.4")
  const viaEntry = await v.list({ version: "1.8.9" })
  assert.ok(viaEntry.length > 15000, "entry wins, option evaporates")
})
