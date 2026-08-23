// ═══════════════════════════════════════════════════════════════════════════
//  WebAuthn primitives — CBOR, authenticator data, COSE keys, signatures.
//
//  Plain JS on purpose (not .ts): the edge function imports it under Deno AND
//  the test suite imports the SAME file under Node, so what ships is what was
//  tested. Nothing here touches Deno or Node APIs — only WebCrypto, TextDecoder
//  and atob/btoa, which both runtimes provide.
//
//  No CDN dependency in the authentication path is deliberate: an auth check is
//  the last place to accept a package that can change under us.
// ═══════════════════════════════════════════════════════════════════════════

// ── bytes ──────────────────────────────────────────────────────────────────
export const b64uToBytes = (s) => {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const bytesToB64u = (b) => {
  const arr = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const randB64u = (n = 32) => bytesToB64u(crypto.getRandomValues(new Uint8Array(n)))
export const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
export const sameBytes = (a, b) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ── minimal CBOR decoder ───────────────────────────────────────────────────
// Enough for WebAuthn: unsigned/negative ints, byte strings, text strings,
// arrays, maps and true/false/null. Returns [value, indexAfterValue].
export function cborDecode(b, i = 0) {
  const major = b[i] >> 5, info = b[i] & 0x1f
  let val = info, j = i + 1
  if (info === 24) { val = b[j]; j += 1 }
  else if (info === 25) { val = (b[j] << 8) | b[j + 1]; j += 2 }
  else if (info === 26) { val = ((b[j] << 24) >>> 0) + (b[j + 1] << 16) + (b[j + 2] << 8) + b[j + 3]; j += 4 }
  else if (info === 27) { let n = 0; for (let k = 0; k < 8; k++) n = n * 256 + b[j + k]; val = n; j += 8 }
  else if (info > 27) throw new Error('CBOR: bad length')

  switch (major) {
    case 0: return [val, j]
    case 1: return [-1 - val, j]
    case 2: return [b.slice(j, j + val), j + val]
    case 3: return [new TextDecoder().decode(b.slice(j, j + val)), j + val]
    case 4: {
      const arr = []
      for (let k = 0; k < val; k++) { const [v, nx] = cborDecode(b, j); arr.push(v); j = nx }
      return [arr, j]
    }
    case 5: {
      const map = new Map()
      for (let k = 0; k < val; k++) {
        const [mk, n1] = cborDecode(b, j)
        const [mv, n2] = cborDecode(b, n1)
        map.set(mk, mv); j = n2
      }
      return [map, j]
    }
    case 7:
      if (info === 20) return [false, j]
      if (info === 21) return [true, j]
      if (info === 22) return [null, j]
      throw new Error('CBOR: unsupported simple value')
    default: throw new Error('CBOR: unsupported major type ' + major)
  }
}

// ── authenticator data ─────────────────────────────────────────────────────
// rpIdHash(32) | flags(1) | signCount(4) | [aaguid(16) credIdLen(2) credId key]
export function parseAuthData(b) {
  if (!b || b.length < 37) throw new Error('Authenticator data too short')
  const flags = b[32]
  const out = {
    rpIdHash: b.slice(0, 32),
    userPresent: !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    signCount: ((b[33] << 24) >>> 0) + (b[34] << 16) + (b[35] << 8) + b[36],
  }
  if (flags & 0x40) {
    const idLen = (b[53] << 8) | b[54]
    out.credentialId = b.slice(55, 55 + idLen)
    const keyStart = 55 + idLen
    // Decode the COSE key to find where it ends, so the stored bytes are exactly
    // the key even when extension data follows it.
    const [, end] = cborDecode(b, keyStart)
    out.cosePublicKey = b.slice(keyStart, end)
  }
  return out
}

// ── keys + signatures ──────────────────────────────────────────────────────
// COSE key → WebCrypto key. kty 2 = EC2 (ES256), kty 3 = RSA (RS256) — the two
// algorithms Apple, Google and Microsoft platform authenticators emit.
export async function importCoseKey(cose) {
  const [m] = cborDecode(cose, 0)
  if (!(m instanceof Map)) throw new Error('Bad public key')
  const kty = m.get(1), alg = m.get(3)
  if (kty === 2) {
    if (alg !== -7) throw new Error('Unsupported EC algorithm')
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: bytesToB64u(m.get(-2)), y: bytesToB64u(m.get(-3)), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return { key, alg: 'ES256' }
  }
  if (kty === 3) {
    if (alg !== -257) throw new Error('Unsupported RSA algorithm')
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'RSA', n: bytesToB64u(m.get(-1)), e: bytesToB64u(m.get(-2)), alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    return { key, alg: 'RS256' }
  }
  throw new Error('Unsupported key type')
}

// WebAuthn ECDSA signatures are DER (SEQUENCE of two INTEGERs); WebCrypto wants
// raw r||s, 32 bytes each.
export function derToRawEcdsa(der) {
  if (der[0] !== 0x30) throw new Error('Bad ECDSA signature')
  let i = 2
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f)
  const readInt = () => {
    if (der[i] !== 0x02) throw new Error('Bad ECDSA signature')
    const len = der[i + 1]
    let v = der.slice(i + 2, i + 2 + len)
    i += 2 + len
    while (v.length > 32 && v[0] === 0x00) v = v.slice(1)
    if (v.length > 32) throw new Error('Bad ECDSA signature')
    const out = new Uint8Array(32)
    out.set(v, 32 - v.length)
    return out
  }
  const r = readInt(), s = readInt()
  const raw = new Uint8Array(64)
  raw.set(r, 0); raw.set(s, 32)
  return raw
}

export async function verifySignature(cose, signature, signedData) {
  const { key, alg } = await importCoseKey(cose)
  if (alg === 'ES256') {
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRawEcdsa(signature), signedData)
  }
  return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signedData)
}

// The authenticator signs client data, so these three checks are what bind a
// ceremony to OUR origin and OUR challenge. `allowedOrigins` is passed in so the
// list lives with the deployment, not in this module.
export function checkClientData(clientDataJSON, expectedType, expectedChallenge, allowedOrigins) {
  const cd = JSON.parse(new TextDecoder().decode(b64uToBytes(clientDataJSON)))
  if (cd.type !== expectedType) throw new Error('Wrong ceremony type')
  if (cd.challenge !== expectedChallenge) throw new Error('Challenge mismatch')
  if (!allowedOrigins.includes(cd.origin)) throw new Error(`Origin not allowed: ${cd.origin}`)
  return cd
}

// The Relying Party ID scopes a passkey. The PARENT domain means ONE passkey
// works on both admin.partvault.app and app.partvault.app.
export const rpIdFor = (origin) => {
  try {
    const h = new URL(origin).hostname
    if (h === 'partvault.app' || h.endsWith('.partvault.app')) return 'partvault.app'
    return h
  } catch { return 'partvault.app' }
}

// Verify a registration (attestation) response. Returns the credential to store.
// Attestation itself is NOT verified: we request attestation 'none', the norm for
// consumer passkeys — the credential belongs to the session that just made it,
// which is all registration needs to establish.
export async function verifyRegistration({ clientDataJSON, attestationObject, expectedChallenge, allowedOrigins }) {
  const cd = checkClientData(clientDataJSON, 'webauthn.create', expectedChallenge, allowedOrigins)
  const [att] = cborDecode(b64uToBytes(attestationObject), 0)
  if (!(att instanceof Map)) throw new Error('Bad passkey response')
  const authData = parseAuthData(att.get('authData'))
  if (!sameBytes(authData.rpIdHash, await sha256(new TextEncoder().encode(rpIdFor(cd.origin))))) {
    throw new Error('This passkey was made for a different site')
  }
  if (!authData.userPresent || !authData.userVerified) throw new Error('Face ID / Touch ID was not confirmed')
  if (!authData.credentialId || !authData.cosePublicKey) throw new Error('No credential in the response')
  return {
    credentialId: bytesToB64u(authData.credentialId),
    publicKey: bytesToB64u(authData.cosePublicKey),
    counter: authData.signCount,
    origin: cd.origin,
  }
}

// Verify an authentication (assertion) response against a stored credential.
export async function verifyAssertion({ clientDataJSON, authenticatorData, signature, publicKey, expectedChallenge, allowedOrigins, storedCounter = 0 }) {
  const cd = checkClientData(clientDataJSON, 'webauthn.get', expectedChallenge, allowedOrigins)
  const authDataBytes = b64uToBytes(authenticatorData)
  const authData = parseAuthData(authDataBytes)
  if (!sameBytes(authData.rpIdHash, await sha256(new TextEncoder().encode(rpIdFor(cd.origin))))) {
    throw new Error('This passkey was made for a different site')
  }
  if (!authData.userPresent || !authData.userVerified) throw new Error('Face ID / Touch ID was not confirmed')

  const clientHash = await sha256(b64uToBytes(clientDataJSON))
  const signedData = new Uint8Array(authDataBytes.length + clientHash.length)
  signedData.set(authDataBytes, 0)
  signedData.set(clientHash, authDataBytes.length)

  const ok = await verifySignature(b64uToBytes(publicKey), b64uToBytes(signature), signedData)
  if (!ok) throw new Error('That signature could not be verified')

  // Clone detection: a counter that goes backwards means a copied credential.
  // Platform passkeys usually report 0 and never move it, so this only applies
  // when the authenticator actually maintains a counter.
  if (storedCounter > 0 && authData.signCount > 0 && authData.signCount <= storedCounter) {
    throw new Error('This passkey looks copied — sign in with your email instead')
  }
  return { counter: authData.signCount, origin: cd.origin }
}
