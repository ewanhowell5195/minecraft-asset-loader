// Live getters: identifiers, extension safety, eras, entry-bound forms.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import MinecraftAssets from "../src/index.js"

const CACHE = path.join(os.tmpdir(), "minecraft-assets-tests", "getters")
const mc = new MinecraftAssets({ cacheDir: CACHE, version: "1.21.4" })

test("getTexture: every id spelling names the same file", async () => {
  for (const id of [
    "block/stone",
    "block/stone.png",
    "minecraft:block/stone",
    "minecraft:textures/block/stone",
    "textures/block/stone",
    "assets/minecraft/textures/block/stone",
    "assets/minecraft/textures/block/stone.png"
  ]) {
    assert.equal((await mc.getTexture(id))?.length, 157, id)
  }
  assert.equal(await mc.getTexture("block/not_a_real_texture"), null)
})

test("getTexture meta: rides along, extension-safe, null when absent", async () => {
  for (const id of ["block/fire_0", "block/fire_0.png", "assets/minecraft/textures/block/fire_0.png"]) {
    const { data, meta } = await mc.getTexture(id, { meta: true })
    assert.ok(data.length > 0, id)
    assert.ok(meta.animation, id)
  }
  const plain = await mc.getTexture("block/stone", { meta: true })
  assert.ok(plain.data.length === 157 && plain.meta === null)
  assert.equal(await mc.getTexture("block/nope", { meta: true }), null)
})

test("getModel / getBlockstate / getItemDefinition parse json", async () => {
  assert.equal((await mc.getModel("block/stone")).parent, "minecraft:block/cube_all")
  assert.equal((await mc.getModel("block/stone.json")).parent, "minecraft:block/cube_all")
  assert.ok((await mc.getBlockstate("stone")).variants)
  assert.ok((await mc.getItemDefinition("diamond_sword")).model)
  assert.equal(await mc.getModel("block/nope"), null)
})

test("getSound: by path, objects auto-opted, extension-safe", async () => {
  const a = await mc.getSound("note/pling")
  const b = await mc.getSound("note/pling.ogg")
  assert.ok(a.length > 1000)
  assert.equal(a.length, b.length)
  assert.equal(await mc.getSound("note/nope"), null)
})

test("getStructure: every era's location, id spellings", async () => {
  const modern = await mc.getStructure("igloo/top")
  assert.ok(modern.length > 100)
  for (const id of ["igloo/top.nbt", "minecraft:igloo/top", "structure/igloo/top", "data/minecraft/structure/igloo/top.nbt"]) {
    assert.equal((await mc.getStructure(id))?.length, modern.length, id)
  }
  assert.ok((await mc.getStructure("igloo/top", { version: "1.16.5" })).length > 100, "falls back to data/.../structures/")
  assert.ok((await mc.getStructure("igloo/igloo_top", { version: "1.12.2" })).length > 100, "falls back to assets/.../structures/")
  assert.equal(await mc.getStructure("igloo/nope"), null)
})

test("namespace: the option sets the default, a prefix overrides", async () => {
  const viaOption = await mc.getTexture("gui/realms/adventure", { version: "1.16.5", namespace: "realms" })
  assert.ok(viaOption.length > 100)
  assert.equal((await mc.getTexture("realms:gui/realms/adventure", { version: "1.16.5" }))?.length, viaOption.length)
  assert.equal(await mc.getTexture("minecraft:gui/realms/adventure", { version: "1.16.5", namespace: "realms" }), null, "the prefix beats the option")

  const lang = await mc.getLang("realms:en_us", { version: "1.16.5" })
  assert.ok(Object.keys(lang).some(k => k.startsWith("mco.")))
  assert.deepEqual(await mc.getLang("en_US", { version: "1.16.5", namespace: "realms" }), lang)
})

test("getLang: modern json, legacy .lang, case and extension forgiven", async () => {
  for (const code of ["en_us", "en_US", "en_us.json"]) {
    assert.equal((await mc.getLang(code))["menu.quit"], "Quit Game", code)
  }
  for (const code of ["en_us", "en_US.lang"]) {
    assert.equal((await mc.getLang(code, { version: "1.8.9" }))["menu.quit"], "Quit Game", code)
  }
  assert.equal(await mc.getLang("xx_yy"), null)
})

test("version option reaches every getter", async () => {
  const old = await mc.getTexture("blocks/stone", { version: "1.8.9" })
  assert.ok(old.length > 0)
  assert.equal(await mc.getTexture("block/stone", { version: "1.8.9" }), null, "modern path does not exist there")
})

test("entry-bound getters mirror the top level exactly", async () => {
  const v = await mc.manifest.version("1.8.9")
  assert.equal((await v.getTexture("blocks/stone"))?.length, (await mc.getTexture("blocks/stone", { version: "1.8.9" }))?.length)
  assert.equal((await v.getLang("en_US"))["menu.quit"], "Quit Game")
  assert.ok((await v.getModel("block/stone")))
  assert.ok((await v.getSound("note/harp")).length === 6137)
  const v2 = await mc.manifest.version("1.21.4")
  assert.equal((await v2.getStructure("igloo/top"))?.length, (await mc.getStructure("igloo/top"))?.length)
  assert.equal((await v.getTexture("blocks/stone", { version: "1.21.4" }))?.length, (await v.getTexture("blocks/stone"))?.length, "version option evaporates on entries")
})
