// The local .minecraft install: jars, indexes, and objects served from disk, verified, with fallback.

import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import MinecraftAssets from "../src/index.js"
import { objectUrl } from "../src/objects.js"
import { hashFromUrl } from "../src/util.js"
import { defaultMinecraftDir, LocalInstall } from "../src/local.js"

const FAKE = path.join(os.tmpdir(), "minecraft-assets-tests", "local-fake")
const JAR_VERSION = "b1.7.3"
const SOUND = "assets/minecraft/sounds/note/pling.ogg"

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function put(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
}

async function offline(fn) {
  const real = globalThis.fetch
  globalThis.fetch = async url => { throw new Error("OFFLINE: " + url) }
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

const setup = new MinecraftAssets({ cacheAPI: {}, minecraft: false })
const details = await setup.manifest.details("1.21.4")
const index = details.assetIndex
const indexBytes = new Uint8Array(await (await fetch(index.url)).arrayBuffer())
const soundHash = JSON.parse(new TextDecoder().decode(indexBytes)).objects[SOUND.slice("assets/".length)].hash
const soundBytes = new Uint8Array(await (await fetch(objectUrl(soundHash))).arrayBuffer())
const client = (await setup.manifest.details(JAR_VERSION)).downloads.client
const jarBytes = new Uint8Array(await (await fetch(client.url)).arrayBuffer())
const jarRow = JSON.parse(JSON.stringify(await setup.manifest.version(JAR_VERSION)))
const assetsRow = JSON.parse(JSON.stringify(await setup.manifest.version("1.21.4")))

// assets mode derives its index list from the version details, so seed what it keeps to work offline
function withIndexes() {
  const map = { [hashFromUrl(assetsRow.url)]: index }
  const store = new Map([[ "meta/asset_indexes", new TextEncoder().encode(JSON.stringify(map)) ]])
  return { read: k => store.get(k), write: (k, d) => store.set(k, d) }
}

await fs.rm(FAKE, { recursive: true, force: true })
await put(path.join(FAKE, "assets", "indexes", index.id + ".json"), indexBytes)
await put(path.join(FAKE, "assets", "objects", soundHash.slice(0, 2), soundHash), soundBytes)
await put(path.join(FAKE, "versions", JAR_VERSION, JAR_VERSION + ".jar"), jarBytes)

test("jar: served and listed from disk, fully offline", async () => {
  const store = new Map()
  const api = { read: k => store.get(k), write: (k, d) => store.set(k, d) }
  const warm = new MinecraftAssets({ cacheAPI: api, minecraft: FAKE, version: JAR_VERSION })
  const terrain = await warm.read("terrain.png")
  assert.ok(terrain.length > 1000)
  assert.ok(!Array.from(store.keys()).some(k => k.startsWith("blobs/jar_")), "the local jar is not copied into the cache")
  assert.ok(store.has("meta/local_jar_" + client.sha1), "the verified jar leaves a trust note")
  await sleep(600)

  await offline(async () => {
    const mc = new MinecraftAssets({ cacheAPI: api, minecraft: FAKE, version: JAR_VERSION, manifest: { versions: [jarRow] } })
    assert.deepEqual(Array.from(await mc.read("terrain.png")), Array.from(terrain))
    assert.ok((await mc.list()).some(f => f.path === "pack.png"))

    const off = new MinecraftAssets({ cacheAPI: api, minecraft: false, version: JAR_VERSION, manifest: { versions: [jarRow] } })
    await assert.rejects(off.read("terrain.png"), /OFFLINE/, "minecraft: false really turns it off")
  })
})

test("assets mode: index and objects from disk, fully offline", async () => {
  await offline(async () => {
    const mc = new MinecraftAssets({ cacheAPI: withIndexes(), minecraft: FAKE, type: "assets", version: index.id, manifest: { versions: [assetsRow] } })
    assert.ok((await mc.list()).length > 3000)
    assert.deepEqual(Array.from(await mc.read(SOUND)), Array.from(soundBytes))
    assert.ok((await mc.getSound("note/pling")).length === soundBytes.length)

    const off = new MinecraftAssets({ cacheAPI: {}, minecraft: false, type: "assets", version: index.id, manifest: { versions: [assetsRow] } })
    await assert.rejects(off.list(), /OFFLINE/)
  })
})

test("corrupt local files are ignored, not served", async () => {
  const bad = path.join(os.tmpdir(), "minecraft-assets-tests", "local-bad")
  await fs.rm(bad, { recursive: true, force: true })
  const evil = new Uint8Array(soundBytes)
  evil[0] ^= 0xff
  await put(path.join(bad, "assets", "indexes", index.id + ".json"), new TextEncoder().encode("{}"))
  await put(path.join(bad, "assets", "objects", soundHash.slice(0, 2), soundHash), evil)
  const badJar = new Uint8Array(jarBytes)
  badJar[100] ^= 0xff
  await put(path.join(bad, "versions", JAR_VERSION, JAR_VERSION + ".jar"), badJar)

  const mc = new MinecraftAssets({ cacheAPI: withIndexes(), minecraft: bad, type: "assets", version: index.id, manifest: { versions: [assetsRow] } })
  assert.deepEqual(Array.from(await mc.read(SOUND)), Array.from(soundBytes), "hash mismatch falls back to the network")

  const store = new Map()
  const java = new MinecraftAssets({ cacheAPI: { read: k => store.get(k), write: (k, d) => store.set(k, d) }, minecraft: bad, version: JAR_VERSION })
  assert.ok((await java.read("terrain.png")).length > 1000)
  assert.ok(!store.has("meta/local_jar_" + client.sha1), "a tampered jar is never trusted")
  await fs.rm(bad, { recursive: true, force: true })
})

const realDir = defaultMinecraftDir()
const hasReal = await fs.access(path.join(realDir, "versions")).then(() => true, () => false)

test("the real install is auto-detected and serves its jars", { skip: !hasReal && "no local .minecraft on this machine" }, async t => {
  const store = new Map()
  const mc = new MinecraftAssets({ cacheAPI: { read: k => store.get(k), write: (k, d) => store.set(k, d) } })
  const local = new LocalInstall(realDir, { get: () => undefined, set: () => {} })
  const installed = await fs.readdir(path.join(realDir, "versions"))

  let version = null
  for (const id of installed) {
    const entry = await mc.manifest.version(id)
    if (!entry || entry.legacyLayout) continue
    const client = (await entry.details()).downloads?.client
    if (client && await local.jar(id, client)) {
      version = id
      break
    }
  }
  if (!version) return t.skip("no vanilla versions installed")

  const files = await mc.list({ version })
  assert.ok(files.length > 1000)
  const file = files.find(f => f.size > 0 && !f.hash)
  assert.equal((await mc.read(file.path, { version })).length, file.size)
  assert.ok(!Array.from(store.keys()).some(k => k.startsWith("blobs/jar_")), "served from the install, nothing downloaded")
})

test("a vanished file mid-session falls back cleanly", async () => {
  const gone = path.join(os.tmpdir(), "minecraft-assets-tests", "local-gone")
  await fs.rm(gone, { recursive: true, force: true })
  await put(path.join(gone, "versions", JAR_VERSION, JAR_VERSION + ".jar"), jarBytes)
  const mc = new MinecraftAssets({ cacheAPI: {}, minecraft: gone, version: JAR_VERSION })
  await mc.list()
  await fs.rm(gone, { recursive: true, force: true })
  assert.ok((await mc.read("terrain.png")).length > 1000, "reads switch to the network when the file disappears")
})
