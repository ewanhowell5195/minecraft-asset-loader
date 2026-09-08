const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const FAST_BITS = 9
const FAST_SIZE = 1 << FAST_BITS
const FAST_MASK = FAST_SIZE - 1

function huffman(lengths, n) {
  const count = new Uint16Array(16)
  for (let i = 0; i < n; i++) count[lengths[i]]++
  count[0] = 0
  const offsets = new Uint16Array(16)
  const next = new Uint16Array(16)
  let code = 0
  for (let len = 1; len < 16; len++) {
    offsets[len] = offsets[len - 1] + count[len - 1]
    code = (code + count[len - 1]) << 1
    next[len] = code
  }
  const symbol = new Uint16Array(n)
  const fast = new Uint16Array(FAST_SIZE)
  for (let i = 0; i < n; i++) {
    const len = lengths[i]
    if (!len) continue
    symbol[offsets[len]++] = i
    const c = next[len]++
    if (len > FAST_BITS) continue
    let rev = 0
    for (let b = 0; b < len; b++) rev |= ((c >> b) & 1) << (len - 1 - b)
    const packed = (len << 9) | i
    for (let j = rev; j < FAST_SIZE; j += 1 << len) fast[j] = packed
  }
  return { count, symbol, fast }
}

const fixedLengths = new Uint8Array(288)
fixedLengths.fill(8, 0, 144)
fixedLengths.fill(9, 144, 256)
fixedLengths.fill(7, 256, 280)
fixedLengths.fill(8, 280, 288)
const FIXED_LIT = huffman(fixedLengths, 288)
const FIXED_DIST = huffman(new Uint8Array(30).fill(5), 30)

export function inflateSync(src, size) {
  let out = new Uint8Array(size ?? Math.max(1024, src.length * 4))
  let pos = 0
  let ip = 0
  let bitBuf = 0
  let bitCnt = 0
  const end = src.length

  const fill = n => {
    while (bitCnt < n) {
      bitBuf |= (ip < end ? src[ip] : 0) << bitCnt
      ip++
      bitCnt += 8
    }
  }

  const bits = n => {
    if (bitCnt < n) fill(n)
    const v = bitBuf & ((1 << n) - 1)
    bitBuf >>>= n
    bitCnt -= n
    return v
  }

  const decode = h => {
    if (bitCnt < FAST_BITS) fill(FAST_BITS)
    const hit = h.fast[bitBuf & FAST_MASK]
    if (hit) {
      const len = hit >> 9
      bitBuf >>>= len
      bitCnt -= len
      return hit & 511
    }
    let code = 0
    let first = 0
    let index = 0
    const count = h.count
    for (let len = 1; len <= 15; len++) {
      code |= bits(1)
      const c = count[len]
      if (code - c < first) return h.symbol[index + (code - first)]
      index += c
      first += c
      first <<= 1
      code <<= 1
    }
    throw new Error("Invalid deflate data")
  }

  const grow = need => {
    if (need <= out.length) return
    const bigger = new Uint8Array(Math.max(need, out.length * 2))
    bigger.set(out.subarray(0, pos))
    out = bigger
  }

  while (true) {
    const last = bits(1)
    const type = bits(2)
    if (type === 0) {
      ip -= bitCnt >> 3
      bitBuf = 0
      bitCnt = 0
      const len = src[ip] | (src[ip + 1] << 8)
      ip += 4
      grow(pos + len)
      out.set(src.subarray(ip, ip + len), pos)
      ip += len
      pos += len
    } else if (type === 1 || type === 2) {
      let lit = FIXED_LIT
      let dist = FIXED_DIST
      if (type === 2) {
        const nlen = bits(5) + 257
        const ndist = bits(5) + 1
        const ncode = bits(4) + 4
        const lengths = new Uint8Array(320)
        for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]] = bits(3)
        const lencode = huffman(lengths, 19)
        lengths.fill(0)
        let i = 0
        while (i < nlen + ndist) {
          const sym = decode(lencode)
          if (sym < 16) lengths[i++] = sym
          else {
            let repeat
            let value = 0
            if (sym === 16) {
              value = lengths[i - 1]
              repeat = 3 + bits(2)
            } else if (sym === 17) repeat = 3 + bits(3)
            else repeat = 11 + bits(7)
            lengths.fill(value, i, i + repeat)
            i += repeat
          }
        }
        lit = huffman(lengths, nlen)
        dist = huffman(lengths.subarray(nlen), ndist)
      }
      while (true) {
        const sym = decode(lit)
        if (sym < 256) {
          if (pos >= out.length) grow(pos + 1)
          out[pos++] = sym
        } else if (sym === 256) break
        else {
          const li = sym - 257
          const len = LEN_BASE[li] + bits(LEN_EXTRA[li])
          const di = decode(dist)
          const d = DIST_BASE[di] + bits(DIST_EXTRA[di])
          grow(pos + len)
          let from = pos - d
          for (let k = 0; k < len; k++) out[pos++] = out[from++]
        }
      }
    } else throw new Error("Invalid deflate block type")
    if (last) break
  }
  return pos === out.length ? out : out.subarray(0, pos)
}
