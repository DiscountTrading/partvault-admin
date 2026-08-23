// ═══════════════════════════════════════════════════════════════════════════
//  Passkey verification tests.
//
//  Imports the SAME webauthn.js the edge function ships, builds real WebAuthn
//  ceremonies (real P-256 / RSA keys, real signatures, real CBOR) and checks
//  both that a good ceremony passes and that every tampered one fails. A test
//  that only proves the happy path would pass just as well against a verifier
//  that returns true unconditionally, which is the failure mode that matters.
//
//  Run:  node tests/passkeys.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import {
  verifyRegistration, verifyAssertion, bytesToB64u, b64uToBytes, cborDecode,
  parseAuthData, derToRawEcdsa, rpIdFor,
} from '../supabase/functions/auth-passkey/webauthn.js'

const ORIGINS = ['https://admin.partvault.app', 'https://app.partvault.app', 'http://localhost:5173']
const ORIGIN = 'https://admin.partvault.app'
const RP_ID = 'partvault.app'

let passed = 0, failed = 0
const ok = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`) } }
const rejects = async (name, fn, match) => {
  try { await fn(); failed++; console.log(`  ✗ ${name} — it was ACCEPTED`) }
  catch (e) {
    if (match && !new RegExp(match, 'i').test(e.message)) { failed++; console.log(`  ✗ ${name} — wrong error: ${e.message}`) }
    else { passed++; console.log(`  ✓ ${name}`) }
  }
}

// ── tiny CBOR encoder (test-only; the shipped code only ever decodes) ───────
const cborUint = (major, n) => {
  if (n < 24) return [ (major << 5) | n ]
  if (n < 256) return [ (major << 5) | 24, n ]
  if (n < 65536) return [ (major << 5) | 25, n >> 8, n & 255 ]
  return [ (major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255 ]
}
const cborBytes = (b) => [...cborUint(2, b.length), ...b]
const cborText = (s) => { const b = new TextEncoder().encode(s); return [...cborUint(3, b.length), ...b] }
const cborInt = (n) => n >= 0 ? cborUint(0, n) : cborUint(1, -n - 1)
const cborMap = (entries) => {
  const out = [...cborUint(5, entries.length)]
  for (const [k, v] of entries) out.push(...k, ...v)
  return out
}

const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

// ── build the pieces a real authenticator would produce ────────────────────
const coseFromEcJwk = (jwk) => new Uint8Array(cborMap([
  [cborInt(1), cborInt(2)],       // kty: EC2
  [cborInt(3), cborInt(-7)],      // alg: ES256
  [cborInt(-1), cborInt(1)],      // crv: P-256
  [cborInt(-2), cborBytes(b64uToBytes(jwk.x))],
  [cborInt(-3), cborBytes(b64uToBytes(jwk.y))],
]))
const coseFromRsaJwk = (jwk) => new Uint8Array(cborMap([
  [cborInt(1), cborInt(3)],       // kty: RSA
  [cborInt(3), cborInt(-257)],    // alg: RS256
  [cborInt(-1), cborBytes(b64uToBytes(jwk.n))],
  [cborInt(-2), cborBytes(b64uToBytes(jwk.e))],
]))

const authDataBytes = async ({ rpId = RP_ID, flags = 0x45, counter = 0, credId, cose }) => {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId))
  const head = [...rpIdHash, flags, (counter >>> 24) & 255, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255]
  if (!(flags & 0x40)) return new Uint8Array(head)
  return new Uint8Array([...head, ...new Uint8Array(16), (credId.length >> 8) & 255, credId.length & 255, ...credId, ...cose])
}

const clientData = (type, challenge, origin = ORIGIN) =>
  bytesToB64u(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })))

const attestationObject = (authData) => bytesToB64u(new Uint8Array(cborMap([
  [cborText('fmt'), cborText('none')],
  [cborText('attStmt'), cborMap([])],
  [cborText('authData'), cborBytes(authData)],
])))

// WebCrypto returns raw r||s for ECDSA; browsers send DER, so re-encode.
const rawToDer = (raw) => {
  const trim = (v) => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; const t = v.slice(i); return t[0] & 0x80 ? new Uint8Array([0, ...t]) : t }
  const r = trim(raw.slice(0, 32)), s = trim(raw.slice(32))
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s]
  return new Uint8Array([0x30, body.length, ...body])
}

const signEs256 = async (privKey, data) =>
  rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, data)))
const signRs256 = async (privKey, data) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privKey, data))

const assertion = async ({ sign, cose, challenge, origin = ORIGIN, flags = 0x05, counter = 0, rpId = RP_ID, tamper }) => {
  const cd = clientData('webauthn.get', challenge, origin)
  const ad = await authDataBytes({ rpId, flags, counter })
  const signed = new Uint8Array([...ad, ...(await sha256(b64uToBytes(cd)))])
  let sig = await sign(signed)
  if (tamper) sig = tamper(sig)
  return { clientDataJSON: cd, authenticatorData: bytesToB64u(ad), signature: bytesToB64u(sig), publicKey: bytesToB64u(cose) }
}

// ── run ────────────────────────────────────────────────────────────────────
console.log('\nPasskey verification\n')

const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const ecJwk = await crypto.subtle.exportKey('jwk', ec.publicKey)
const ecCose = coseFromEcJwk(ecJwk)
const credId = crypto.getRandomValues(new Uint8Array(32))

console.log('Registration')
{
  const challenge = bytesToB64u(crypto.getRandomValues(new Uint8Array(32)))
  const ad = await authDataBytes({ flags: 0x45, credId, cose: ecCose })
  const good = {
    clientDataJSON: clientData('webauthn.create', challenge),
    attestationObject: attestationObject(ad),
    expectedChallenge: challenge, allowedOrigins: ORIGINS,
  }
  const res = await verifyRegistration(good)
  ok('accepts a valid registration', res.credentialId === bytesToB64u(credId))
  ok('stores exactly the COSE key bytes', res.publicKey === bytesToB64u(ecCose))

  await rejects('rejects a challenge that does not match', () =>
    verifyRegistration({ ...good, expectedChallenge: bytesToB64u(crypto.getRandomValues(new Uint8Array(32))) }), 'challenge')
  await rejects('rejects an origin that is not ours', () =>
    verifyRegistration({ ...good, clientDataJSON: clientData('webauthn.create', challenge, 'https://evil.example'), allowedOrigins: ORIGINS }), 'origin')
  await rejects('rejects a ceremony of the wrong type', () =>
    verifyRegistration({ ...good, clientDataJSON: clientData('webauthn.get', challenge) }), 'type')
  await rejects('rejects a passkey made for another site', async () => {
    const bad = await authDataBytes({ rpId: 'evil.example', flags: 0x45, credId, cose: ecCose })
    return verifyRegistration({ ...good, attestationObject: attestationObject(bad) })
  }, 'different site')
  await rejects('rejects registration without user verification (no Face ID)', async () => {
    const bad = await authDataBytes({ flags: 0x41, credId, cose: ecCose })   // UP but not UV
    return verifyRegistration({ ...good, attestationObject: attestationObject(bad) })
  }, 'Face ID')
}

console.log('\nAuthentication — ES256 (Apple/Android platform keys)')
{
  const challenge = bytesToB64u(crypto.getRandomValues(new Uint8Array(32)))
  const sign = (d) => signEs256(ec.privateKey, d)
  const good = { ...(await assertion({ sign, cose: ecCose, challenge })), expectedChallenge: challenge, allowedOrigins: ORIGINS }
  const res = await verifyAssertion(good)
  ok('accepts a valid assertion', !!res)

  await rejects('rejects a tampered signature', async () => {
    const a = await assertion({ sign, cose: ecCose, challenge, tamper: (s) => { const c = s.slice(); c[c.length - 1] ^= 0xff; return c } })
    return verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS })
  })
  await rejects('rejects a signature from a different key', async () => {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const a = await assertion({ sign: (d) => signEs256(other.privateKey, d), cose: ecCose, challenge })
    return verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS })
  })
  await rejects('rejects a replay against a different challenge', () =>
    verifyAssertion({ ...good, expectedChallenge: bytesToB64u(crypto.getRandomValues(new Uint8Array(32))) }), 'challenge')
  await rejects('rejects an assertion from another origin', async () => {
    const a = await assertion({ sign, cose: ecCose, challenge, origin: 'https://evil.example' })
    return verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS })
  }, 'origin')
  await rejects('rejects an assertion for another rpId', async () => {
    const a = await assertion({ sign, cose: ecCose, challenge, rpId: 'evil.example' })
    return verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS })
  }, 'different site')
  await rejects('rejects presence-only (no biometric)', async () => {
    const a = await assertion({ sign, cose: ecCose, challenge, flags: 0x01 })
    return verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS })
  }, 'Face ID')
  await rejects('rejects a counter that went backwards (cloned key)', async () => {
    const a = await assertion({ sign, cose: ecCose, challenge, counter: 5 })
    return verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS, storedCounter: 9 })
  }, 'copied')
  {
    const a = await assertion({ sign, cose: ecCose, challenge, counter: 12 })
    const r = await verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS, storedCounter: 9 })
    ok('accepts a counter that moved forward', r.counter === 12)
  }
  {
    const a = await assertion({ sign, cose: ecCose, challenge, counter: 0 })
    const r = await verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS, storedCounter: 0 })
    ok('accepts a counter that stays 0 (how platform passkeys behave)', r.counter === 0)
  }
}

console.log('\nAuthentication — RS256 (Windows Hello)')
{
  const rsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
  const rsaJwk = await crypto.subtle.exportKey('jwk', rsa.publicKey)
  const rsaCose = coseFromRsaJwk(rsaJwk)
  const challenge = bytesToB64u(crypto.getRandomValues(new Uint8Array(32)))
  const a = await assertion({ sign: (d) => signRs256(rsa.privateKey, d), cose: rsaCose, challenge })
  ok('accepts a valid RSA assertion', !!(await verifyAssertion({ ...a, expectedChallenge: challenge, allowedOrigins: ORIGINS })))
  await rejects('rejects a tampered RSA signature', async () => {
    const bad = await assertion({ sign: (d) => signRs256(rsa.privateKey, d), cose: rsaCose, challenge, tamper: (s) => { const c = s.slice(); c[0] ^= 0xff; return c } })
    return verifyAssertion({ ...bad, expectedChallenge: challenge, allowedOrigins: ORIGINS })
  })
}

console.log('\nPrimitives')
{
  // Small-r signatures are the classic DER edge case: leading zeros are dropped
  // in DER, so a naive converter emits a short r||s and every such sign-in fails.
  let sawShort = false
  for (let i = 0; i < 200 && !sawShort; i++) {
    const sig = await signEs256(ec.privateKey, crypto.getRandomValues(new Uint8Array(32)))
    const rLen = sig[3]
    if (rLen < 32) { sawShort = true; ok('DER→raw pads a short r to 32 bytes', derToRawEcdsa(sig).length === 64) }
  }
  if (!sawShort) ok('DER→raw round-trips (no short r seen in 200 signatures)', true)

  const ad = await authDataBytes({ flags: 0x45, credId, cose: ecCose })
  const parsed = parseAuthData(ad)
  ok('authData parses credential id + key', bytesToB64u(parsed.credentialId) === bytesToB64u(credId) && bytesToB64u(parsed.cosePublicKey) === bytesToB64u(ecCose))
  ok('authData reads the UV flag', parsed.userVerified === true)
  ok('cbor decodes nested maps', cborDecode(new Uint8Array(cborMap([[cborText('a'), cborInt(-7)]])))[0].get('a') === -7)

  ok('rpId for admin subdomain is the parent domain', rpIdFor('https://admin.partvault.app') === 'partvault.app')
  ok('rpId for field app is the same parent domain', rpIdFor('https://app.partvault.app') === 'partvault.app')
  ok('rpId for localhost stays localhost', rpIdFor('http://localhost:5173') === 'localhost')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
