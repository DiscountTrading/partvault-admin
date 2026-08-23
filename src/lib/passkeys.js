// ═══════════════════════════════════════════════════════════════════════════
//  Passkeys — Face ID / Touch ID / Windows Hello as a real sign-in.
//
//  KEEP THIS FILE IDENTICAL IN BOTH APPS (admin + field). One passkey covers
//  both: the edge function scopes credentials to the PARENT domain
//  (partvault.app), so a key created on app.partvault.app signs you in on
//  admin.partvault.app and back.
//
//  This is NOT the old biometric app-lock (lib/biometric.js), which only gated a
//  session that was already on the device. Here the authenticator signs a
//  server-issued challenge, the server verifies it against the stored public
//  key, and only then is a session minted — so Face ID can sign you in on a
//  device with no session at all.
// ═══════════════════════════════════════════════════════════════════════════
import { sb } from './supabase'

const PASSKEY_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/auth-passkey'

// ── base64url ⇄ bytes (WebAuthn speaks ArrayBuffers, JSON speaks strings) ───
const toBytes = (b64u) => {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const toB64u = (buf) => {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const call = async (action, payload = {}, { auth = false } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) {
    const { data: { session } } = await sb.auth.getSession()
    if (!session?.access_token) throw new Error('Sign-in required')
    headers.Authorization = `Bearer ${session.access_token}`
  }
  const res = await fetch(PASSKEY_FN, { method: 'POST', headers, body: JSON.stringify({ action, ...payload }) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || d.error) throw new Error(d.error || 'Passkey request failed')
  return d
}

// Is a passkey even possible here? (Older browsers, and desktops with no
// biometric hardware, answer no — the UI must not offer what can't work.)
export const passkeySupported = () =>
  typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.create

export async function platformAuthenticatorAvailable() {
  if (!passkeySupported()) return false
  try { return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() }
  catch { return false }
}

// What the button should say on this device.
export const biometricLabel = () => {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod|Macintosh/.test(ua)) return 'Face ID / Touch ID'
  if (/Android/.test(ua)) return 'fingerprint or face unlock'
  if (/Windows/.test(ua)) return 'Windows Hello'
  return 'your device passkey'
}

// ── register (needs a session — you add a passkey to your own account) ──────
export async function registerPasskey(label) {
  if (!passkeySupported()) throw new Error('This browser can\'t do Face ID sign-in')
  const { options } = await call('register_options', {}, { auth: true })
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({ ...c, id: toBytes(c.id) })),
    },
  })
  if (!cred) throw new Error('Setup was cancelled')
  await call('register_verify', {
    credential: {
      rawId: toB64u(cred.rawId),
      label: label || deviceLabel(),
      response: {
        clientDataJSON: toB64u(cred.response.clientDataJSON),
        attestationObject: toB64u(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : null,
      },
    },
  }, { auth: true })
  return true
}

// ── sign in (no session — this IS the sign-in) ─────────────────────────────
export async function signInWithPasskey() {
  if (!passkeySupported()) throw new Error('This browser can\'t do Face ID sign-in')
  const { options } = await call('auth_options')
  const cred = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      allowCredentials: [],          // discoverable: the device offers what it holds
    },
  })
  if (!cred) throw new Error('Sign-in was cancelled')
  const { tokenHash, email } = await call('auth_verify', {
    credential: {
      rawId: toB64u(cred.rawId),
      response: {
        clientDataJSON: toB64u(cred.response.clientDataJSON),
        authenticatorData: toB64u(cred.response.authenticatorData),
        signature: toB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null,
      },
    },
  })
  // Same one-time-token exchange the phone-approve flow uses.
  const { error } = await sb.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
  if (error) throw new Error(error.message)
  return { email }
}

export const listPasskeys = () => call('list', {}, { auth: true }).then(d => d.passkeys || [])
export const deletePasskey = (id) => call('delete', { id }, { auth: true })

// A name the owner will recognise in the device list.
export function deviceLabel() {
  const ua = navigator.userAgent || ''
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  return 'This device'
}

// Has this browser been used to set a passkey up? Only a hint for the UI — the
// server is the authority, and sign-in works on any device that holds a key.
const HINT = 'pv_passkey_hint'
export const rememberPasskeyOnThisDevice = () => { try { localStorage.setItem(HINT, '1') } catch { /* private mode */ } }
export const forgetPasskeyOnThisDevice = () => { try { localStorage.removeItem(HINT) } catch { /* private mode */ } }
export const hasPasskeyHint = () => { try { return localStorage.getItem(HINT) === '1' } catch { return false } }
