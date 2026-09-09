import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { decoder } from "./util.js"

export function defaultMinecraftDir() {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), ".minecraft")
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "minecraft")
  return path.join(os.homedir(), ".minecraft")
}

function sha1(bytes) {
  return crypto.createHash("sha1").update(bytes).digest("hex")
}

async function sha1File(file) {
  const hash = crypto.createHash("sha1")
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

export class LocalInstall {
  constructor(dir, store) {
    this.dir = dir
    this.store = store
  }

  async object(hash) {
    try {
      const bytes = await fs.promises.readFile(path.join(this.dir, "assets", "objects", hash.slice(0, 2), hash))
      if (sha1(bytes) === hash) return bytes
    } catch {}
    return null
  }

  async index(id, hash) {
    if (!hash) return null
    try {
      const bytes = await fs.promises.readFile(path.join(this.dir, "assets", "indexes", id + ".json"))
      if (sha1(bytes) === hash) return JSON.parse(decoder.decode(bytes))
    } catch {}
    return null
  }

  async jar(id, client) {
    if (!client?.sha1) return null
    const file = path.join(this.dir, "versions", id, id + ".jar")
    try {
      const stat = await fs.promises.stat(file)
      if (client.size != null && stat.size !== client.size) return null
      const key = "local_jar_" + client.sha1
      const note = await this.store.get("meta", key)
      if (note?.size === stat.size && note.mtime === stat.mtimeMs) return file
      if (await sha1File(file) !== client.sha1) return null
      await this.store.set("meta", key, { size: stat.size, mtime: stat.mtimeMs })
      return file
    } catch {
      return null
    }
  }
}
