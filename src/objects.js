export const OBJECTS_URL = "https://resources.download.minecraft.net/"

export function rootIndex(index) {
  const objects = index?.objects ?? {}
  const keys = Object.keys(objects)
  const namespaced = keys.some(k => k.startsWith("minecraft/"))
  const root = namespaced ? "assets/" : "assets/minecraft/"
  const map = new Map()
  for (const key of keys) {
    const { hash, size } = objects[key]
    if (typeof hash !== "string") continue
    const path = key === "pack.mcmeta" ? key : root + key
    map.set(path, { hash, size })
  }
  return map
}

export const objectUrl = hash => OBJECTS_URL + hash.slice(0, 2) + "/" + hash
