// Live Bedrock edition: versions from bedrock-samples releases, whole-zip content, full zip and archive fallback.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets, { readZip } from "../src/index.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "bedrock")
const FULL = "1.26.50.27-preview"
const ARCHIVE = "1.19.30"

const mc = new MinecraftAssets({ type: "bedrock", cacheDir: CACHE, version: FULL })

test("unknown type throws", () => {
  assert.throws(() => new MinecraftAssets({ type: "pocket" }), /pocket/)
})

test("manifest: releases become versions, previews are snapshots", async () => {
  const all = await mc.manifest.versions()
  assert.ok(all.length > 200)
  assert.ok(Date.parse(all[0].releaseTime) > Date.parse(all.at(-1).releaseTime))
  assert.ok(all.every(v => v.type === "release" || v.type === "snapshot"))
  assert.ok(all.every(v => typeof v.zip?.url === "string"))

  const { release, snapshot, newest } = await mc.manifest.latest()
  assert.equal(release.type, "release")
  assert.ok(snapshot.id.includes("preview"))
  assert.equal(newest, all[0])
  assert.equal(await mc.manifest.version("release"), release)

  assert.equal(typeof release.zip.size, "number", "this release carries the full zip asset")
  const old = await mc.manifest.version(ARCHIVE)
  assert.equal(old.zip.size, null)
  assert.ok(old.zip.archive, "releases without the asset fall back to the archive zip")

  const fresh = new MinecraftAssets({ type: "bedrock", cacheDir: CACHE })
  await fresh.setVersion("snapshot")
  assert.equal(fresh.channel, "snapshot")
  assert.ok(fresh.version.includes("preview"))

  const { VersionType } = await import("../src/index.js")
  const main = await mc.manifest.versions(VersionType.MAIN)
  assert.ok(main.length > 20 && main.length < all.length)
  const lines = main.filter(v => v.type === "release").map(v => v.id.split(".").slice(0, 3).join("."))
  assert.equal(new Set(lines).size, lines.length, "one entry per update line")
  assert.ok(new Set(lines.map(l => l.split(".").slice(0, 2).join("."))).size < lines.length, "updates are finer than major.minor")
})

test("full zip: listing through the lens", async () => {
  const files = await mc.list()
  assert.ok(files.length > 20000)
  assert.ok(files.every(f => f.source === undefined), "one source, so no source field")
  assert.equal(typeof files[0].crc, "number")
  assert.ok(!files.some(f => f.path.startsWith(".github/") || f.path === ".gitignore"))
  assert.ok(!files.some(f => !f.path.includes("/") && f.path.toLowerCase().endsWith(".md")))
  const roots = new Set(files.map(f => f.path.split("/")[0]))
  assert.deepEqual([...roots].sort(), ["behavior_pack", "documentation", "metadata", "resource_pack"])

  assert.equal(await mc.list({ objects: true }), files, "the objects flag means nothing on bedrock")
  assert.equal((await mc.loadObjects()).size, 0)
})

test("getters: bedrock mappings and namespace rules", async () => {
  const stone = await mc.getTexture("blocks/stone")
  assert.ok(stone.length > 100)
  for (const id of ["blocks/stone.png", "minecraft:blocks/stone", "textures/blocks/stone", "resource_pack/textures/blocks/stone.png"]) {
    assert.equal((await mc.getTexture(id))?.length, stone.length, id)
  }
  assert.equal(await mc.getTexture("quark:blocks/stone"), null, "other namespaces miss")
  assert.equal(await mc.getTexture("blocks/stone", { namespace: "quark" }), null, "the namespace option misses too")
  assert.equal((await mc.getTexture("blocks/stone", { namespace: "minecraft" }))?.length, stone.length)

  assert.ok((await mc.getTexture("blocks/acacia_shelf_mers")).length > 100, "tga textures resolve")
  const { data, meta } = await mc.getTexture("blocks/stone", { meta: true })
  assert.equal(data.length, stone.length)
  assert.ok(meta && typeof meta === "object", "meta is the texture_set sidecar")

  assert.ok((await mc.getModel("entity/allay"))["minecraft:geometry"])
  assert.ok(await mc.getModel("mobs"), "plain json models resolve too")
  assert.equal((await mc.getBlockstate("black_concrete_slab"))["minecraft:block"].description.identifier, "minecraft:black_concrete_slab")
  assert.ok((await mc.getItemDefinition("apple"))["minecraft:item"])
  assert.ok((await mc.getSound("ambient/nether/crimson_forest/mood1")).length > 10000)
  assert.equal((await mc.getLang("en_US"))["item.apple.name"], "Apple")
  assert.equal((await mc.getLang("en_us"))["item.apple.name"], "Apple")
  assert.equal(await mc.getLang("en_US", { namespace: "quark" }), null)
  assert.equal(await mc.getStructure("igloo/top"), null, "bedrock-samples ships no structures")
})

test("export matches direct reads", async () => {
  const zip = await mc.export({ filter: p => p.startsWith("resource_pack/textures/blocks/stone.") })
  const entries = readZip(zip)
  assert.ok(entries.length >= 2)
  const one = entries.find(e => e.path === "resource_pack/textures/blocks/stone.png")
  assert.deepEqual(Array.from(await one.read()), Array.from(await mc.read(one.path)))
})

test("loadJar: a cached zip reports complete at its full size", async () => {
  const ticks = []
  await mc.loadJar({ onProgress: (done, total) => ticks.push([done, total]) })
  assert.equal(ticks.length, 1)
  assert.equal(ticks[0][0], ticks[0][1])
  assert.ok(ticks[0][1] > 100_000_000)
})

test("archive fallback: root folder stripped, noise trimmed", async () => {
  const ticks = []
  await mc.loadJar({ version: ARCHIVE, onProgress: (done, total) => ticks.push([done, total]) })
  if (ticks.length > 1) {
    assert.equal(new Set(ticks.map(([, total]) => total)).size, 1, "the total is whatever the server declared, consistently")
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i][0] >= ticks[i - 1][0])
  }

  const files = await mc.list({ version: ARCHIVE })
  assert.ok(files.length > 5000)
  assert.ok(!files.some(f => f.path.startsWith("bedrock-samples-")), "the archive root folder is stripped")
  assert.ok(files.some(f => f.path === "version.json"))
  assert.ok(!files.some(f => f.path === "CONTRIBUTING.md" || f.path === ".gitignore"))
  assert.ok((await mc.getTexture("blocks/stone", { version: ARCHIVE })).length > 100)
  assert.equal((await mc.getLang("en_US", { version: ARCHIVE }))["item.apple.name"], "Apple")
})
