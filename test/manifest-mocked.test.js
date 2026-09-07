// Manifest lifecycle against a mocked network: laziness, expiry, ownership.

import test from "node:test"
import assert from "node:assert/strict"
import MinecraftAssets from "../src/index.js"

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const sleep = ms => new Promise(r => setTimeout(r, ms))

const manifestJson = n => ({
  versions: [{ id: "fake-" + n, type: "release", releaseTime: "2026-01-01T00:00:00Z", url: "https://piston-meta.mojang.com/v1/packages/aaaaaaaaaa/1.json" }]
})

function mockFetch({ headers = {}, onFetch = () => {} } = {}) {
  let n = 0
  globalThis.fetch = async url => {
    if (String(url) !== MANIFEST_URL) throw new Error("unexpected url " + url)
    n++
    onFetch(n)
    return new Response(JSON.stringify(manifestJson(n)), { headers: { "content-type": "application/json", ...headers } })
  }
  return () => n
}

test("nothing is fetched at construction, once on first need", async () => {
  const count = mockFetch()
  const mc = new MinecraftAssets({ cacheAPI: {} })
  await sleep(50)
  assert.equal(count(), 0)
  await mc.manifest.versions()
  await mc.manifest.latest()
  assert.equal(count(), 1)
})

test("expiry honours Cache-Control max-age", async () => {
  const count = mockFetch({ headers: { "cache-control": "public, max-age=1" } })
  const mc = new MinecraftAssets({ cacheAPI: {} })
  assert.equal((await mc.manifest.latest()).release.id, "fake-1")
  await mc.manifest.versions()
  assert.equal(count(), 1)
  await sleep(1100)
  assert.equal(count(), 1, "nothing fires between calls")
  assert.equal((await mc.manifest.latest()).release.id, "fake-2")
})

test("an Age header eating the window means refetch per use", async () => {
  const count = mockFetch({ headers: { "cache-control": "max-age=10", "age": "10" } })
  const mc = new MinecraftAssets({ cacheAPI: {} })
  await mc.manifest.versions()
  await sleep(10)
  await mc.manifest.versions()
  assert.equal(count(), 2)
})

test("no headers falls back to a long window; Infinity disables", async () => {
  const count = mockFetch()
  const mc = new MinecraftAssets({ cacheAPI: {} })
  await mc.manifest.versions()
  await sleep(150)
  await mc.manifest.versions()
  assert.equal(count(), 1)

  const count2 = mockFetch({ headers: { "cache-control": "max-age=0" } })
  const mc2 = new MinecraftAssets({ cacheAPI: {}, manifestExpiry: Infinity })
  await mc2.manifest.versions()
  await mc2.manifest.versions()
  assert.equal(count2(), 1)
})

test("a failed expiry refresh serves the stale copy, then recovers", async () => {
  let fail = false
  let n = 0
  globalThis.fetch = async () => {
    n++
    if (fail) throw new TypeError("network down")
    return new Response(JSON.stringify(manifestJson(n)), { headers: { "content-type": "application/json", "cache-control": "max-age=1" } })
  }
  const mc = new MinecraftAssets({ cacheAPI: {} })
  assert.equal((await mc.manifest.latest()).release.id, "fake-1")
  await sleep(1100)
  fail = true
  assert.equal((await mc.manifest.latest()).release.id, "fake-1", "stale served")
  fail = false
  const recovered = (await mc.manifest.latest()).release.id
  assert.notEqual(recovered, "fake-1")
})

test("a cached manifest serves fresh instances until it expires", async () => {
  const count = mockFetch({ headers: { "cache-control": "max-age=1" } })
  const store = new Map()
  const api = { read: k => store.get(k), write: (k, d) => store.set(k, d) }

  const a = new MinecraftAssets({ cacheAPI: api })
  await a.manifest.versions()
  assert.equal(count(), 1)

  const b = new MinecraftAssets({ cacheAPI: api })
  assert.equal((await b.manifest.latest()).release.id, "fake-1", "served from the cache")
  assert.equal(count(), 1, "no refetch inside the trust window")

  await sleep(1100)
  const c = new MinecraftAssets({ cacheAPI: api })
  await c.manifest.versions()
  assert.equal(count(), 2, "an expired cached copy is refetched")
})

test("update(json): cloned, owned, never refetched, replaceable", async () => {
  const count = mockFetch()
  const mine = manifestJson(99)
  const mc = new MinecraftAssets({ cacheAPI: {}, manifest: mine })

  assert.equal((await mc.manifest.latest()).release.id, "fake-99")
  assert.equal(await mc.manifest.version("fake-1"), null, "miss stays a miss")
  assert.equal(count(), 0, "zero network in manual mode")

  assert.ok(!("legacyLayout" in mine.versions[0]), "caller objects untouched")
  assert.notEqual(await mc.manifest.version("fake-99"), mine.versions[0])

  await mc.manifest.update(manifestJson(50))
  assert.equal((await mc.manifest.latest()).release.id, "fake-50")
  assert.equal(count(), 0)
})

test("update() refetches and hands ownership back", async () => {
  const count = mockFetch({ headers: { "cache-control": "max-age=1" } })
  const mc = new MinecraftAssets({ cacheAPI: {}, manifest: manifestJson(99) })
  await mc.manifest.update()
  assert.equal((await mc.manifest.latest()).release.id, "fake-1")
  assert.equal(count(), 1)
  await sleep(1100)
  await mc.manifest.versions()
  assert.equal(count(), 2, "auto-expiry resumed")
})

test("update(garbage) throws; update() failure throws loudly", async () => {
  const mc = new MinecraftAssets({ cacheAPI: {}, manifest: manifestJson(1) })
  await assert.rejects(() => mc.manifest.update({ nope: true }), /Not a version manifest/)

  globalThis.fetch = async () => { throw new TypeError("down") }
  await assert.rejects(() => mc.manifest.update())
  assert.equal((await mc.manifest.latest()).release.id, "fake-1", "manual copy survives the failed refetch")
})
