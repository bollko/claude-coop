// Room encryption, so the relay (and any tunnel in front of it) sees only ciphertext.
// The module environment's crypto.subtle has digest alone, so this is built from it:
// SHA-512 in counter mode as the keystream, then HMAC-SHA-256 over nonce and ciphertext
// (encrypt-then-MAC). Keys come from the room name and secret, so a weak secret is
// guessable offline: /coop host generates a random one.

const enc = new TextEncoder()
const dec = new TextDecoder()
const PREFIX = 'e1:'

const sha = async (alg: 'SHA-256' | 'SHA-512', ...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.length
  }

  return new Uint8Array(await crypto.subtle.digest(alg, all))
}

const hmac = async (key: Uint8Array, msg: Uint8Array) => {
  const k = new Uint8Array(64)
  k.set(key.length > 64 ? await sha('SHA-256', key) : key)

  return sha('SHA-256', k.map(b => b ^ 0x5c), await sha('SHA-256', k.map(b => b ^ 0x36), msg))
}

const keystreamXor = async (key: Uint8Array, nonce: Uint8Array, data: Uint8Array) => {
  const out = new Uint8Array(data.length)
  const counter = new Uint8Array(4)
  for (let block = 0; block * 64 < data.length; block++) {
    new DataView(counter.buffer).setUint32(0, block)
    const ks = await sha('SHA-512', key, nonce, counter)
    for (let i = 0; i < 64 && block * 64 + i < data.length; i++) out[block * 64 + i] = data[block * 64 + i]! ^ ks[i]!
  }

  return out
}

const toBase64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))

  return btoa(s)
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

// access is what the relay checks; it never sees the secret, so it can't derive the other two.
export type RoomKeys = { enc: Uint8Array; mac: Uint8Array; access: string }

export const roomKeys = async (room: string, secret: string): Promise<RoomKeys> => ({
  enc: await sha('SHA-256', enc.encode(`claude-coop enc|${room}|${secret}`)),
  mac: await sha('SHA-256', enc.encode(`claude-coop mac|${room}|${secret}`)),
  access: [...(await sha('SHA-256', enc.encode(`claude-coop access|${room}|${secret}`)))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join(''),
})

export const seal = async (keys: RoomKeys, plain: string) => {
  const nonce = crypto.getRandomValues(new Uint8Array(16))
  const ct = await keystreamXor(keys.enc, nonce, enc.encode(plain))
  const tag = await hmac(keys.mac, new Uint8Array([...nonce, ...ct]))

  return PREFIX + toBase64(new Uint8Array([...nonce, ...ct, ...tag]))
}

export const isSealed = (text: string) => text.startsWith(PREFIX)

// The plaintext, or undefined when the text was not sealed with these keys or was altered.
export const open = async (keys: RoomKeys, sealed: string) => {
  if (!isSealed(sealed)) return undefined
  let raw: Uint8Array
  try {
    raw = fromBase64(sealed.slice(PREFIX.length))
  } catch {
    return undefined
  }
  if (raw.length < 48) return undefined
  const nonce = raw.subarray(0, 16)
  const ct = raw.subarray(16, raw.length - 32)
  const tag = raw.subarray(raw.length - 32)
  const want = await hmac(keys.mac, raw.subarray(0, raw.length - 32))
  // Compare every byte, so the time taken says nothing about where they differ.
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= want[i]! ^ tag[i]!
  if (diff) return undefined

  return dec.decode(await keystreamXor(keys.enc, nonce, ct))
}
