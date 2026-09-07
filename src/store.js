import { isNode, encoder, decoder } from "./util.js"

const swallow = async fn => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError("cacheAPI.read must return bytes")
}

function apiBackend(api) {
  return {
    async get(store, key) {
      const value = await api.read?.(store + "/" + key)
      if (value == null) return undefined
      const bytes = toBytes(value)
      return store === "meta" ? JSON.parse(decoder.decode(bytes)) : bytes
    },
    async set(store, key, value) {
      await api.write?.(store + "/" + key, store === "meta" ? encoder.encode(JSON.stringify(value)) : value)
    },
    async clear() {
      await api.clear?.()
    }
  }
}

function builtinBackend(dir, maxSize) {
  let impl
  const load = () => impl ??= isNode
    ? import("./cache.js").then(m => new m.FileCache(dir, { maxSize }))
    : import("./opfs-cache.js").then(m => new m.OpfsCache(dir, { maxSize }))
  return {
    get: async (store, key) => (await load()).get(store, key),
    set: async (store, key, value) => (await load()).set(store, key, value),
    clear: async () => (await load()).clear()
  }
}

export function createStore({ cacheAPI, cacheDir, cacheSize } = {}) {
  const backend = cacheAPI ? apiBackend(cacheAPI) : builtinBackend(cacheDir, cacheSize)
  return {
    get: (store, key) => swallow(() => backend.get(store, key)),
    set: (store, key, value) => swallow(() => backend.set(store, key, value)),
    clear: () => swallow(() => backend.clear())
  }
}
