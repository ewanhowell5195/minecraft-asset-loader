// Live manifest behaviour: version lists, filters, lookups, details, enrichment.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets, { VersionType, LEGACY_ASSETS_BEFORE } from "../src/index.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "manifest")

const real = globalThis.fetch
let fetches = []
globalThis.fetch = (url, init) => {
  fetches.push(String(url))
  return real(url, init)
}

const mc = new MinecraftAssets({ cacheDir: CACHE })

test("versions() returns everything, newest first", async () => {
  const all = await mc.manifest.versions()
  assert.ok(all.length > 800)
  assert.ok(Date.parse(all[0].releaseTime) > Date.parse(all.at(-1).releaseTime))
  assert.ok(all.some(v => v.id === "1.0"))
  assert.ok(all.some(v => v.id === "1.21.4"))
})

test("versions(type string) filters by type", async () => {
  const releases = await mc.manifest.versions(VersionType.RELEASE)
  assert.ok(releases.length > 80)
  assert.ok(releases.every(v => v.type === "release"))
  const alphas = await mc.manifest.versions(VersionType.ALPHA)
  assert.ok(alphas.every(v => v.type === "old_alpha"))
})

test("versions(VersionType.MAIN) is the curated picker list", async () => {
  const main = await mc.manifest.versions(VersionType.MAIN)
  assert.ok(main.length > 20 && main.length < 80)
  const ids = main.map(v => v.id)
  assert.ok(ids.includes("1.16.5"))
  assert.ok(ids.includes("1.21.4"))
  assert.ok(!ids.includes("1.16.4"))
})

test("versions(VersionType.MODERN) is the assets/ era", async () => {
  const modern = await mc.manifest.versions(VersionType.MODERN)
  assert.ok(modern.length > 500)
  assert.ok(modern.every(v => !v.legacyLayout))
  assert.ok(modern.some(v => v.id === "1.6.1"))
  assert.ok(!modern.some(v => v.id === "1.5.2"))
})

test("versions(fn) and arrays union in manifest order", async () => {
  const custom = await mc.manifest.versions(all => all.filter(v => v.id.startsWith("1.21.")))
  assert.ok(custom.length > 5)
  assert.ok(custom.every(v => v.id.startsWith("1.21.")))

  const mixed = await mc.manifest.versions([VersionType.MAIN, VersionType.BETA])
  assert.ok(mixed.some(v => v.type === "old_beta"))
  assert.ok(mixed.some(v => v.id === "1.16.5"))
  for (let i = 1; i < mixed.length; i++) {
    assert.ok(Date.parse(mixed[i - 1].releaseTime) >= Date.parse(mixed[i].releaseTime))
  }
})

test("custom keyword by assignment on VersionType", async () => {
  VersionType.TEST_STABLE = all => all.filter(v => v.type === "release" && !v.id.includes("-"))
  try {
    const stable = await mc.manifest.versions(VersionType.TEST_STABLE)
    assert.ok(stable.length > 80)
    assert.ok(stable.every(v => v.type === "release"))
  } finally {
    delete VersionType.TEST_STABLE
  }
})

test("version(id): hit, and a miss is a miss with no refetch", async () => {
  const v = await mc.manifest.version("1.21.4")
  assert.equal(v.id, "1.21.4")

  const latest = await mc.manifest.latest()
  for (const k of ["release", "snapshot", "newest"]) assert.equal(await mc.manifest.version(k), latest[k], k)

  const before = fetches.length
  assert.equal(await mc.manifest.version("definitely-not-a-version"), null)
  assert.equal(fetches.length, before)
})

test("latest(): release, genuine snapshot, newest, shared identity", async () => {
  const { release, snapshot, newest } = await mc.manifest.latest()
  assert.equal(release.type, "release")
  assert.equal(snapshot.type, "snapshot")
  const all = await mc.manifest.versions()
  assert.equal(newest, all[0])
  assert.ok(all.includes(release))
})

test("details(): full document, accepts entries, memoised", async () => {
  const d = await mc.manifest.details("1.21.4")
  assert.ok(d.downloads.client.sha1)
  assert.ok(d.assetIndex.url)
  assert.equal(d.id, "1.21.4")

  const entry = await mc.manifest.version("1.21.4")
  const before = fetches.length
  const d2 = await mc.manifest.details(entry)
  assert.equal(d2, d)
  assert.equal(fetches.length, before)
})

test("enrichment: legacyLayout, methods non-enumerable, stable identity", async () => {
  const modern = await mc.manifest.version("1.21.4")
  const ancient = await mc.manifest.version("1.5.2")
  const first = await mc.manifest.version("1.6.1")
  assert.equal(modern.legacyLayout, false)
  assert.equal(ancient.legacyLayout, true)
  assert.equal(first.legacyLayout, false)

  for (const m of ["details", "list", "search", "file", "read", "getTexture", "getModel", "getBlockstate", "getItemDefinition", "getSound", "getLang", "getStructure", "loadJar", "loadObjects", "export"]) {
    assert.equal(typeof modern[m], "function", m)
    assert.ok(!Object.keys(modern).includes(m), m + " enumerable")
  }
  assert.ok(JSON.stringify(modern).includes('"legacyLayout":false'))

  const again = await mc.manifest.versions()
  assert.equal(again.find(v => v.id === "1.21.4"), modern)
})

test("LEGACY_ASSETS_BEFORE is the 13w24a instant", () => {
  assert.equal(LEGACY_ASSETS_BEFORE, Date.parse("2013-06-13T15:32:23+00:00"))
})

test("manifest versions keep working through a Proxy", async () => {
  const version = await mc.manifest.version("1.21.4")
  const proxied = new Proxy(version, {})
  assert.equal((await proxied.details()).id, "1.21.4")
  assert.ok((await proxied.list()).length > 15000)
})
