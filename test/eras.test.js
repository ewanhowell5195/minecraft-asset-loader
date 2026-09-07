// Every era the manifest reaches, through the public API only.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets from "../src/index.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "eras")
const mc = new MinecraftAssets({ cacheDir: CACHE })

test("a1.2.6: root layout, tiny jar, readable", async () => {
  const files = await mc.list({ version: "a1.2.6" })
  assert.equal(files.length, 64)
  assert.ok(!files.some(f => f.path.startsWith("assets/")), "nothing namespaced yet")
  assert.ok(files.some(f => f.path === "armor/chain_1.png"))
  const bytes = await mc.read("armor/chain_1.png", { version: "a1.2.6" })
  assert.ok(bytes.length > 100)
  assert.equal((await mc.manifest.version("a1.2.6")).legacyLayout, true)
})

test("1.5.2: jar at root, objects namespaced, pack.mcmeta at the root", async () => {
  const files = await mc.list({ version: "1.5.2", objects: true })
  const jarSide = files.filter(f => f.source === "jar")
  const objSide = files.filter(f => f.source === "object")
  assert.ok(jarSide.some(f => f.path === "textures/blocks/stone.png"), "jar files sit at the root")
  assert.ok(objSide.every(f => f.path.startsWith("assets/minecraft/") || f.path === "pack.mcmeta"), "old index roots at assets/minecraft")
  assert.ok(files.some(f => f.path === "pack.mcmeta"), "the one root exception")

  const tex = await mc.read("textures/blocks/stone.png", { version: "1.5.2" })
  assert.ok(tex.length > 100)
  const mcmeta = await mc.read("pack.mcmeta", { version: "1.5.2", objects: true })
  assert.ok(JSON.parse(new TextDecoder().decode(mcmeta)).pack)
})

test("1.5.2: sounds live under newsound/, so getSound is honestly null", async () => {
  const files = await mc.list({ version: "1.5.2", objects: true })
  const cave = files.find(f => f.path === "assets/minecraft/newsound/ambient/cave/cave1.ogg")
  assert.equal(cave.source, "object")
  assert.ok((await cave.read()).length > 1000)
  assert.equal(await mc.getSound("ambient/cave/cave1", { version: "1.5.2" }), null)
})

test("1.6.1: the first assets/ era, getters work", async () => {
  const files = await mc.list({ version: "1.6.1" })
  assert.ok(files.some(f => f.path === "assets/minecraft/textures/blocks/anvil_base.png"))
  assert.equal((await mc.manifest.version("1.6.1")).legacyLayout, false)
  const viaGetter = await mc.getTexture("blocks/anvil_base", { version: "1.6.1" })
  assert.ok(viaGetter.length > 100)
})

test("index rooting flips at 1.7.10", async () => {
  const before = (await mc.list({ version: "1.7.4", objects: true })).filter(f => f.source === "object")
  assert.ok(before.every(f => f.path.startsWith("assets/minecraft/") || f.path === "pack.mcmeta"))

  const after = (await mc.list({ version: "1.7.10", objects: true })).filter(f => f.source === "object")
  assert.ok(after.some(f => f.path.startsWith("assets/icons/")), "namespace-less index entries root at assets/")
})

test("1.8.9: en ships in the jar, every other language is an object", async () => {
  const files = await mc.list({ version: "1.8.9", objects: true })
  assert.ok(files.some(f => f.path === "assets/minecraft/textures/blocks/stone.png"))
  assert.equal(files.find(f => f.path === "assets/minecraft/lang/en_US.lang").source, "jar")
  assert.equal(files.find(f => f.path === "assets/minecraft/lang/de_DE.lang").source, "object")
  assert.equal((await mc.getLang("de_de", { version: "1.8.9" }))["menu.quit"], "Spiel beenden")
})

test("the current snapshot behaves like any release", async () => {
  const { snapshot } = await mc.manifest.latest()
  const files = await mc.list({ version: snapshot.id })
  assert.ok(files.length > 10000)
  assert.ok((await mc.getTexture("block/stone", { version: snapshot.id })).length > 100)
})

test("loadObjects respects old index rooting", async () => {
  const map = await mc.loadObjects({ version: "1.5.2", filter: ["assets/minecraft/newsound/ambient/cave/cave1.ogg"] })
  assert.equal(map.size, 1)
  assert.ok([...map.keys()][0].startsWith("assets/minecraft/newsound/"))
})

test("export of an alpha is its files, faithfully", async () => {
  const { listBuffer, entryFromBuffer } = await import("../src/zip.js")
  const zip = await mc.export({ version: "a1.2.6" })
  const entries = listBuffer(zip)
  assert.equal(entries.length, 64)
  const one = entries.find(e => e.path === "armor/chain_1.png")
  const bytes = await entryFromBuffer(zip, one)
  assert.deepEqual(Array.from(bytes), Array.from(await mc.read("armor/chain_1.png", { version: "a1.2.6" })))
  assert.ok(entries.some(e => e.path === "null"), "the historical zero-byte file survives export")
})
