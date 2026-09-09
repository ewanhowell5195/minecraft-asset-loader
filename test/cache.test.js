// The cache layer: FileCache LRU mechanics, cacheAPI, clearCache, resilience.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import MinecraftAssets from "../src/index.js"
import { FileCache } from "../src/cache.js"

const sleep = ms => new Promise(r => setTimeout(r, ms))
const DIR = path.join(os.tmpdir(), "minecraft-assets-tests", "cache-lru")
const blob = n => new Uint8Array(30_000).fill(n)

test("FileCache: roundtrip, stores, key encoding", async () => {
  await fs.rm(DIR, { recursive: true, force: true })
  const c = new FileCache(DIR)
  await c.set("meta", "a/b:c", { hello: 1 })
  await c.set("blobs", "bytes", blob(7))
  assert.deepEqual(await c.get("meta", "a/b:c"), { hello: 1 })
  assert.equal((await c.get("blobs", "bytes"))[0], 7)
  assert.equal(await c.get("blobs", "missing"), undefined)
  assert.ok((await c.keys("meta")).includes("a/b:c"))
  await c.delete("blobs", "bytes")
  assert.equal(await c.get("blobs", "bytes"), undefined)
})

test("FileCache LRU: metadata counts toward the cap", async () => {
  await fs.rm(DIR, { recursive: true, force: true })
  const c = new FileCache(DIR, { maxSize: 100_000 })
  await c.set("meta", "big-listing", { pad: "x".repeat(40_000) })
  await sleep(15); await c.set("blobs", "b1", blob(1))
  await sleep(15); await c.set("blobs", "b2", blob(2))
  await sleep(15); await c.set("blobs", "b3", blob(3))
  assert.equal(await c.get("meta", "big-listing"), undefined, "oldest entry evicted was the meta one")
  assert.equal((await c.get("blobs", "b3"))[0], 3)
})

test("FileCache LRU: recently read entries survive", async () => {
  await fs.rm(DIR, { recursive: true, force: true })
  const c = new FileCache(DIR, { maxSize: 100_000 })
  await c.set("meta", "listing", { pad: "x".repeat(30_000) })
  await sleep(15); await c.set("blobs", "b1", blob(1))
  await sleep(15); await c.get("meta", "listing")
  await sleep(15); await c.set("blobs", "b2", blob(2))
  await sleep(15); await c.set("blobs", "b3", blob(3))
  assert.equal(await c.get("blobs", "b1"), undefined, "cold blob evicted instead")
  assert.equal((await c.get("meta", "listing")).pad.length, 30_000, "hot meta survives")
})

test("FileCache LRU: survives a restart via mtimes", async () => {
  const c = new FileCache(DIR, { maxSize: 100_000 })
  await sleep(15); await c.get("meta", "listing")
  await sleep(15); await c.set("blobs", "b4", blob(4))
  await sleep(15); await c.set("blobs", "b5", blob(5))
  assert.equal((await c.get("meta", "listing")).pad.length, 30_000)
  await fs.rm(DIR, { recursive: true, force: true })
})

test("FileCache: no cap means no eviction; clear wipes", async () => {
  await fs.rm(DIR, { recursive: true, force: true })
  const c = new FileCache(DIR, { maxSize: Infinity })
  for (let i = 0; i < 10; i++) await c.set("blobs", "b" + i, blob(i))
  assert.equal((await c.keys("blobs")).length, 10)
  await c.clear()
  assert.equal((await c.keys("blobs")).length, 0)
  await fs.rm(DIR, { recursive: true, force: true })
})

test("cacheAPI: prefixed string keys, byte values, full roundtrip", async () => {
  const store = new Map()
  const api = { read: k => store.get(k), write: (k, d) => store.set(k, d) }
  const mc = new MinecraftAssets({ cacheAPI: api, version: "1.21.4", minecraft: false })
  assert.equal((await mc.read("assets/minecraft/textures/block/stone.png")).length, 157)
  await sleep(600)

  assert.ok(store.size >= 3)
  for (const [k, v] of store) {
    assert.ok(k.startsWith("meta/") || k.startsWith("blobs/"), k)
    assert.ok(v instanceof Uint8Array, k)
  }
  assert.ok([...store.keys()].some(k => k.startsWith("blobs/jar_")))
})

test("cacheAPI: a second instance runs offline from the user's store", async () => {
  const store = new Map()
  const api = { read: k => store.get(k), write: (k, d) => store.set(k, d) }
  const warm = new MinecraftAssets({ cacheAPI: api, version: "1.21.4" })
  await warm.read("assets/minecraft/textures/block/stone.png")
  const manifest = { versions: await warm.manifest.versions() }
  await sleep(600)

  const real = globalThis.fetch
  globalThis.fetch = async url => { throw new Error("OFFLINE: " + url) }
  try {
    const off = new MinecraftAssets({ cacheAPI: api, version: "1.21.4", manifest })
    assert.equal((await off.read("assets/minecraft/textures/block/stone.png")).length, 157)
    assert.ok((await off.list()).length > 15000)
  } finally {
    globalThis.fetch = real
  }
})

test("cacheAPI: clearCache reaches clear(); missing functions are fine", async () => {
  const store = new Map()
  let cleared = false
  const mc = new MinecraftAssets({
    cacheAPI: { read: k => store.get(k), write: (k, d) => store.set(k, d), clear: () => { cleared = true; store.clear() } },
    version: "1.21.4"
  })
  await mc.read("assets/minecraft/textures/block/stone.png")
  await mc.clearCache()
  assert.ok(cleared)
  assert.equal(store.size, 0)

  const bare = new MinecraftAssets({ cacheAPI: {}, version: "1.21.4" })
  assert.equal((await bare.read("assets/minecraft/textures/block/stone.png")).length, 157, "an empty cacheAPI is just a permanent miss")
  await bare.clearCache()
})

test("cacheAPI: a hostile cache degrades to misses, never errors", async () => {
  const mc = new MinecraftAssets({
    cacheAPI: {
      read: () => { throw new Error("cache exploded") },
      write: () => { throw new Error("cache exploded") },
      clear: () => { throw new Error("cache exploded") }
    },
    version: "1.21.4"
  })
  assert.equal((await mc.read("assets/minecraft/textures/block/stone.png")).length, 157)
  assert.ok((await mc.search("stone", { extension: "png", limit: 1 })).length === 1)
})

test("clearCache: wipes the directory store", async () => {
  const dir = path.join(os.tmpdir(), "minecraft-assets-tests", "cache-clear")
  await fs.rm(dir, { recursive: true, force: true })
  const mc = new MinecraftAssets({ cacheDir: dir, version: "1.21.4" })
  await mc.read("assets/minecraft/textures/block/stone.png")
  await sleep(600)
  assert.ok((await fs.readdir(dir)).length > 0)
  await mc.clearCache()
  const left = await Promise.all((await fs.readdir(dir).catch(() => []))
    .map(d => fs.readdir(path.join(dir, d)).catch(() => [])))
  assert.equal(left.flat().length, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test("cacheKey separates instances sharing a directory", async () => {
  const dir = path.join(os.tmpdir(), "minecraft-assets-tests", "cache-key")
  await fs.rm(dir, { recursive: true, force: true })
  const a = new MinecraftAssets({ cacheDir: dir, cacheKey: "one", version: "1.21.4" })
  const b = new MinecraftAssets({ cacheDir: dir, cacheKey: "two", version: "1.21.4" })
  await a.read("assets/minecraft/textures/block/stone.png")
  await sleep(600)
  assert.ok((await a.cacheStats()).files > 0)
  assert.equal((await b.cacheStats()).files, 0, "the other key sees nothing")

  const shared = new MinecraftAssets({ cacheDir: dir, cacheKey: "one", version: "1.21.4" })
  assert.ok((await shared.cacheStats()).files > 0, "the same key shares")
  await fs.rm(dir, { recursive: true, force: true })
})

test("cacheStats, listCache, and single-file purge", async () => {
  const dir = path.join(os.tmpdir(), "minecraft-assets-tests", "cache-stats")
  await fs.rm(dir, { recursive: true, force: true })
  const mc = new MinecraftAssets({ cacheDir: dir, version: "1.21.4", minecraft: false })
  await mc.read("assets/minecraft/textures/block/stone.png")
  await sleep(600)

  const stats = await mc.cacheStats()
  assert.ok(stats.files >= 3 && stats.size > 1_000_000)
  const list = await mc.listCache()
  assert.equal(list.length, stats.files)
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].size >= list[i].size, "biggest first")
  assert.ok(list.every(f => /^(meta|blobs)\//.test(f.key)))

  const jar = list.find(f => f.key.startsWith("blobs/jar_"))
  await mc.clearCache(jar.key)
  assert.ok(!(await mc.listCache()).some(f => f.key === jar.key), "one file purged")
  assert.equal((await mc.cacheStats()).files, stats.files - 1)

  const store = new Map()
  const api = {
    read: k => store.get(k),
    write: (k, d) => store.set(k, d),
    delete: k => store.delete(k),
    list: () => Array.from(store, ([key, d]) => ({ key, size: d.length }))
  }
  const mc2 = new MinecraftAssets({ cacheAPI: api, version: "1.21.4" })
  await mc2.read("assets/minecraft/textures/block/stone.png")
  await sleep(600)
  assert.ok((await mc2.cacheStats()).size > 0)
  const key = (await mc2.listCache())[0].key
  await mc2.clearCache(key)
  assert.ok(!store.has(key), "purge reaches the cacheAPI delete")

  assert.equal(await new MinecraftAssets({ cacheAPI: {} }).cacheStats(), null, "no list() means unknowable")
  await fs.rm(dir, { recursive: true, force: true })
})

test("the cache is an accelerator: results identical with none at all", async () => {
  const none = new MinecraftAssets({ cacheAPI: {}, version: "1.21.4" })
  const cached = new MinecraftAssets({ cacheDir: path.join(os.tmpdir(), "minecraft-assets-tests", "cache-acc"), version: "1.21.4" })
  const a = await none.read("assets/minecraft/textures/block/stone.png")
  const b = await cached.read("assets/minecraft/textures/block/stone.png")
  assert.deepEqual(Array.from(a), Array.from(b))
})
