// Cache writes are for later, so nothing waits on one, and a repeat call never refetches while one is in flight.

import test from "node:test"
import assert from "node:assert/strict"
import MinecraftAssets from "../src/index.js"
import { objectUrl } from "../src/objects.js"
import { hashFromUrl } from "../src/util.js"

const WRITE_MS = 200

const ROW = { id: "1.0", type: "release", releaseTime: "2026-01-01T00:00:00Z", url: "https://piston-meta.mojang.com/v1/packages/aaaaaaaaaa/1.0.json" }
const ASSET_INDEX = { id: "7", sha1: "c".repeat(40), size: 10, totalSize: 20, url: "https://piston-meta.mojang.com/v1/packages/cccccccccc/7.json" }
const OBJECT_HASH = "d".repeat(40)
const SOUND = "assets/minecraft/sounds/x.ogg"
const BYTES = new Uint8Array([1, 2, 3])

const sleep = ms => new Promise(r => setTimeout(r, ms))

function harness() {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async url => {
    const u = String(url)
    asked.push(u)
    if (u === ROW.url) return new Response(JSON.stringify({ assetIndex: ASSET_INDEX, downloads: {} }))
    if (u === ASSET_INDEX.url) return new Response(JSON.stringify({ objects: { "minecraft/sounds/x.ogg": { hash: OBJECT_HASH, size: BYTES.length } } }))
    if (u === objectUrl(OBJECT_HASH)) return new Response(BYTES)
    throw new Error("unexpected url " + u)
  }

  const store = new Map([[ "meta/asset_indexes", new TextEncoder().encode(JSON.stringify({ [hashFromUrl(ROW.url)]: ASSET_INDEX })) ]])
  const writes = []
  const cacheAPI = {
    read: k => store.get(k),
    write: async (k, d) => {
      writes.push(k)
      await sleep(WRITE_MS)
      store.set(k, d)
    },
  }
  const mc = new MinecraftAssets({ cacheAPI, type: "assets", manifest: { versions: [ROW] }, version: "7" })
  return { mc, asked, writes, restore: () => { globalThis.fetch = real } }
}

test("a read does not wait for its own cache write", async () => {
  const h = harness()
  try {
    const t = Date.now()
    const bytes = await h.mc.read(SOUND)
    const ms = Date.now() - t
    assert.deepEqual(Array.from(bytes), Array.from(BYTES))
    assert.ok(h.writes.length > 0, "it did start writing to the cache")
    assert.ok(ms < WRITE_MS, `came back in ${ms}ms, before the ${WRITE_MS}ms write`)
  } finally {
    h.restore()
  }
})

test("a repeat read takes the in-memory copy, not a second request", async () => {
  const h = harness()
  try {
    await h.mc.read(SOUND)
    const after = h.asked.length
    await h.mc.read(SOUND)
    await h.mc.list()
    assert.equal(h.asked.length, after, "nothing was fetched twice while the writes were still in flight")
    assert.equal(h.asked.filter(u => u === objectUrl(OBJECT_HASH)).length, 1)
    assert.equal(h.asked.filter(u => u === ASSET_INDEX.url).length, 1)
  } finally {
    h.restore()
  }
})

test("concurrent callers for one object share a single request", async () => {
  const h = harness()
  try {
    const [a, b, c] = await Promise.all([
      h.mc.read(SOUND),
      h.mc.loadObjects(),
      h.mc.read(SOUND),
    ])
    assert.deepEqual(Array.from(a), Array.from(BYTES))
    assert.deepEqual(Array.from(c), Array.from(BYTES))
    assert.deepEqual(Array.from(b.get(SOUND)), Array.from(BYTES))
    assert.equal(h.asked.filter(u => u === objectUrl(OBJECT_HASH)).length, 1, "the bulk load and the reads shared one fetch")
  } finally {
    h.restore()
  }
})
