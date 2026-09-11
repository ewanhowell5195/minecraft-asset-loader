// What a caller-supplied manifest means in each type, and what the library still does with it.

import test from "node:test"
import assert from "node:assert/strict"
import MinecraftAssets from "../src/index.js"
import { hashFromUrl } from "../src/util.js"

const ROW_A = { id: "1.0", type: "release", releaseTime: "2026-01-02T00:00:00Z", url: "https://piston-meta.mojang.com/v1/packages/aaaaaaaaaa/1.0.json" }
const ROW_B = { id: "1.1", type: "release", releaseTime: "2026-01-01T00:00:00Z", url: "https://piston-meta.mojang.com/v1/packages/bbbbbbbbbb/1.1.json" }

const ASSET_INDEX = { id: "7", sha1: "c".repeat(40), size: 10, totalSize: 20, url: "https://piston-meta.mojang.com/v1/packages/cccccccccc/7.json" }

function serveDetails() {
  const real = globalThis.fetch
  const asked = []
  globalThis.fetch = async url => {
    asked.push(String(url))
    return new Response(JSON.stringify({ assetIndex: ASSET_INDEX, downloads: {} }), { headers: { "content-type": "application/json" } })
  }
  return { asked, restore: () => { globalThis.fetch = real } }
}

function offline() {
  const real = globalThis.fetch
  globalThis.fetch = async url => { throw new Error("OFFLINE: " + url) }
  return () => { globalThis.fetch = real }
}

function seeded(rows) {
  const store = new Map(rows.map(row => [
    "meta/details_" + hashFromUrl(row.url),
    new TextEncoder().encode(JSON.stringify({ assetIndex: ASSET_INDEX, downloads: {} })),
  ]))
  return { read: k => store.get(k), write: (k, d) => store.set(k, d) }
}

test("java: a supplied manifest is the version list, used as given", async () => {
  const restore = offline()
  try {
    const mc = new MinecraftAssets({ cacheAPI: {}, manifest: { versions: [ROW_A, ROW_B] } })
    const versions = await mc.manifest.versions()
    assert.deepEqual(versions.map(v => v.id), ["1.0", "1.1"])
  } finally {
    restore()
  }
})

test("assets: a supplied manifest is the version list, and the index list is still derived from it", async () => {
  const net = serveDetails()
  try {
    const mc = new MinecraftAssets({ cacheAPI: {}, type: "assets", manifest: { versions: [ROW_A, ROW_B] } })
    const versions = await mc.manifest.versions()
    assert.deepEqual(versions.map(v => v.id), ["7"], "the asset index, not the versions handed in")
    assert.equal(versions[0].totalSize, 20)
    assert.equal(versions[0].first, "1.1")
    assert.equal(versions[0].last, "1.0")
    assert.deepEqual(net.asked.sort(), [ROW_A.url, ROW_B.url].sort(), "every version's details were read to build it")
  } finally {
    net.restore()
  }
})

test("assets: details already cached means no network at all", async () => {
  const restore = offline()
  try {
    const mc = new MinecraftAssets({ cacheAPI: seeded([ROW_A, ROW_B]), type: "assets", manifest: { versions: [ROW_A, ROW_B] } })
    const versions = await mc.manifest.versions()
    assert.deepEqual(versions.map(v => v.id), ["7"])
  } finally {
    restore()
  }
})

test("assets: a supplied manifest reports progress while it derives", async () => {
  const net = serveDetails()
  const seen = []
  try {
    const mc = new MinecraftAssets({ cacheAPI: {}, type: "assets", manifest: { versions: [ROW_A, ROW_B] }, onManifestProgress: r => seen.push(r) })
    await mc.manifest.versions()
    assert.equal(seen[0], 0)
    assert.equal(seen.at(-1), 1)
    assert.ok(seen.every((r, i) => i === 0 || r >= seen[i - 1]), "never goes backwards")
  } finally {
    net.restore()
  }
})

test("bedrock: a supplied manifest is the github releases array", async () => {
  const restore = offline()
  try {
    const releases = [
      { tag_name: "v1.21.40.3", prerelease: false, published_at: "2026-01-02T00:00:00Z", assets: [{ name: "bedrock-samples-1.21.40.3-full.zip", size: 99, browser_download_url: "https://example.test/full.zip" }] },
      { tag_name: "v1.21.40.1-preview", prerelease: true, published_at: "2026-01-01T00:00:00Z", assets: [] },
    ]
    const mc = new MinecraftAssets({ cacheAPI: {}, type: "bedrock", manifest: releases })
    const versions = await mc.manifest.versions()
    assert.deepEqual(versions.map(v => v.id), ["1.21.40.3", "1.21.40.1-preview"], "the leading v is dropped")
    assert.deepEqual(versions.map(v => v.type), ["release", "snapshot"], "prereleases are snapshots")
    assert.deepEqual(versions[0].zip, { url: "https://example.test/full.zip", size: 99 })
    assert.equal(versions[1].zip.archive, true, "no full zip falls back to the source archive")
  } finally {
    restore()
  }
})

test("bedrock: the library's own version list is not accepted back", () => {
  assert.throws(
    () => new MinecraftAssets({ cacheAPI: {}, type: "bedrock", manifest: { versions: [{ id: "1.0", type: "release", releaseTime: "2026-01-01T00:00:00Z" }] } }),
    /releases array/,
  )
})
