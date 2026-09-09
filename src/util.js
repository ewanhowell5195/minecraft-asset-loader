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

export function memoMap(map, key, factory) {
  let p = map.get(key)
  if (!p) {
    p = Promise.resolve().then(factory)
    map.set(key, p)
    p.catch(() => { if (map.get(key) === p) map.delete(key) })
  }
  return p
}

export async function readBody(res, tick, expected) {
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    tick?.(bytes.length)
    return bytes
  }
  const reader = res.body.getReader()
  if (expected != null) {
    let out = new Uint8Array(expected)
    let at = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (at + value.length > out.length) {
        const bigger = new Uint8Array(Math.max(out.length * 2, at + value.length))
        bigger.set(out.subarray(0, at))
        out = bigger
      }
      out.set(value, at)
      at += value.length
      tick?.(value.length)
    }
    return at === out.length ? out : out.subarray(0, at)
  }
  const parts = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    size += value.length
    tick?.(value.length)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export function define(obj, name, value) {
  Object.defineProperty(obj, name, { value, enumerable: false, configurable: true, writable: true })
}
