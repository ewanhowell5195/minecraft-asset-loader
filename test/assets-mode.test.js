// Live assets mode: the asset indexes as versions, index-only content, no jar anywhere.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets, { readZip } from "../src/index.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "assets-mode")

const mc = new MinecraftAssets({ type: "assets", cacheDir: CACHE })

test("manifest: one entry per asset index, newest first", async () => {
  const all = await mc.manifest.versions()
  assert.ok(all.length >= 56)
  assert.equal(new Set(all.map(v => v.id)).size, all.length)
  assert.ok(Date.parse(all[0].releaseTime) > Date.parse(all.at(-1).releaseTime))
  for (const v of all) {
    assert.ok(v.sha1 && v.url && typeof v.size === "number" && typeof v.totalSize === "number", v.id)
    assert.equal(typeof v.first, "string", "each index remembers the version that introduced it")
    assert.ok(v.type === "release" || v.type === "snapshot")
  }
  assert.equal(all.at(-1).id, "pre-1.6")

  const release = await mc.manifest.version("release")
  assert.equal(release.type, "release")
  const v119 = await mc.manifest.version("1.19")
  assert.equal(v119.type, "release", "an index any release uses counts as release")
  await mc.manifest.versions()
  assert.equal(mc.channel, "release")
  assert.equal(mc.version, release.id)
})

test("listing: index files only, everything object-backed", async () => {
  const files = await mc.list()
  assert.ok(files.length > 3000)
  assert.ok(files.every(f => f.source === "object"))
  assert.ok(files.every(f => typeof f.hash === "string" && f.crc === undefined))
  assert.equal(await mc.list({ objects: true }), files, "the objects flag means nothing here")

  const results = await mc.search("pling", { extension: "ogg", limit: 1 })
  assert.equal(results[0].path, "assets/minecraft/sounds/note/pling.ogg")
  assert.deepEqual(Array.from(await results[0].read()), Array.from(await mc.read(results[0].path)))
})

test("getters: sounds and translations hit, jar-only content misses", async () => {
  assert.ok((await mc.getSound("note/pling")).length > 5000)
  const lang = await mc.getLang("de_de")
  assert.ok(lang && Object.keys(lang).length > 5000)
  assert.equal(await mc.getLang("en_us"), null, "en_us lives in the jar, and there is no jar")
  assert.equal(await mc.getTexture("block/stone"), null)
  assert.equal(await mc.getModel("block/stone"), null)
  assert.equal(await mc.getBlockstate("stone"), null)
  assert.equal(await mc.getStructure("end_city/base_floor"), null)
})

test("legacy indexes: sounds and .lang translations, still no textures", async () => {
  const files = await mc.list({ version: "legacy" })
  assert.ok(files.length > 1000)
  assert.ok(files.some(f => f.path === "assets/minecraft/lang/de_DE.lang"))
  const lang = await mc.getLang("de_DE", { version: "legacy" })
  assert.ok(lang && Object.keys(lang).length > 1000)
  assert.equal(await mc.getTexture("block/stone", { version: "legacy" }), null)
})

test("export matches direct reads", async () => {
  const zip = await mc.export({ filter: p => p.startsWith("assets/minecraft/sounds/note/") })
  const entries = readZip(zip)
  assert.ok(entries.length >= 5)
  const one = entries.find(e => e.path === "assets/minecraft/sounds/note/pling.ogg")
  assert.deepEqual(Array.from(await one.read()), Array.from(await mc.read(one.path)))
})

test("loadJar: prefetches the whole index with byte progress", async () => {
  const ticks = []
  await mc.loadJar({ version: "pre-1.6", onProgress: (done, total) => ticks.push([done, total]) })
  const entry = await mc.manifest.version("pre-1.6")
  assert.equal(new Set(ticks.map(([, total]) => total)).size, 1)
  assert.equal(ticks.at(-1)[0], ticks.at(-1)[1])
  assert.equal(ticks.at(-1)[1], entry.totalSize)
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i][0] >= ticks[i - 1][0])
})
