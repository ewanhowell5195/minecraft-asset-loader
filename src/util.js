export const isNode = typeof process !== "undefined" && typeof process.versions?.node === "string"

export const collator = new Intl.Collator()
export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

export async function pool(items, limit, fn) {
  const arr = Array.from(items)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, arr.length)) }, async () => {
    while (next < arr.length) {
      const i = next++
      await fn(arr[i], i)
    }
  })
  await Promise.all(workers)
}

export function hashFromUrl(url) {
  const parts = String(url).split("/")
  return parts.length >= 2 ? parts[parts.length - 2] : String(url)
}

export function pathFilter(filter) {
  if (filter == null) return () => true
  if (typeof filter === "function") return p => !!filter(p)
  if (Array.isArray(filter)) {
    const set = new Set(filter.map(f => typeof f === "string" ? f : f?.path))
    return p => set.has(p)
  }
  throw new TypeError("filter must be a function or an array of paths/entries")
}

export function memo(obj, key, factory) {
  if (obj[key]) return obj[key]
  const p = Promise.resolve().then(factory)
  obj[key] = p
  p.catch(() => { if (obj[key] === p) obj[key] = null })
  return p
}

export function define(obj, name, value) {
  Object.defineProperty(obj, name, { value, enumerable: false, configurable: true, writable: true })
}
