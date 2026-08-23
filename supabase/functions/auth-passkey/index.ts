// ═══════════════════════════════════════════════════════════════════════════
//  auth-passkey — WebAuthn passkeys (Face ID / Touch ID / Windows Hello) as a
//  real sign-in method for PartVault.
//
//  Deliberately its OWN function, not another action inside ebay-import: that
//  function carries every eBay/sales/store action in the product, and a fault in
//  an auth dependency there would take the whole app down. A fault here can only
//  break sign-in-with-Face-ID, which always falls back to email code/password.
//
//  The crypto lives in ./webauthn.js — plain JS with no CDN dependency, imported
//  unchanged by the Node test suite (tests/passkeys.test.mjs), so what ships is
//  what was tested.
//
//  Session minting reuses the seam the phone-approve flow already trusts: once
//  the assertion verifies, generateLink() mints a ONE-TIME magic-link token for
//  that user and the browser trades it for a session via verifyOtp().
// ═══════════════════════════════════════════════════════════════════════════
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import {
  bytesToB64u, randB64u, rpIdFor, verifyRegistration, verifyAssertion, b64uToBytes,
} from './webauthn.js'

const FN_VERSION = '1.0.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Only these origins may drive a passkey ceremony. The origin is checked against
// what the AUTHENTICATOR signed into client data, not against a request header,
// so it can't be spoofed by a caller.
const ALLOWED_ORIGINS = [
  'https://admin.partvault.app',
  'https://app.partvault.app',
  'http://localhost:5173',
  'http://localhost:5175',
]

const CHALLENGE_TTL_MS = 5 * 60 * 1000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  try {
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || '')
    const rpID = rpIdFor(req.headers.get('Origin') || '')

    // The signed-in caller, for the actions that manage a user's own credentials.
    const requireUser = async () => {
      const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
      if (!jwt) throw new Error('Sign-in required')
      const { data, error } = await sb.auth.getUser(jwt)
      if (error || !data?.user?.email) throw new Error('Sign-in required')
      return data.user
    }

    const newChallenge = async (kind: 'register' | 'auth', userId: string | null) => {
      // Best-effort prune; keeps the table tiny with no cron.
      await sb.from('webauthn_challenges').delete()
        .lt('created_at', new Date(Date.now() - CHALLENGE_TTL_MS).toISOString())
      const challenge = randB64u(32)
      const { error } = await sb.from('webauthn_challenges').insert({ challenge, kind, user_id: userId })
      if (error) throw new Error(`Could not start: ${error.message}`)
      return challenge
    }

    // Consume a challenge: it must exist, be the right kind and be fresh, and it
    // is deleted here so an assertion can never be replayed.
    const consumeChallenge = async (challenge: string, kind: 'register' | 'auth') => {
      const { data: row } = await sb.from('webauthn_challenges')
        .select('*').eq('challenge', challenge).eq('kind', kind).maybeSingle()
      if (!row) throw new Error('That sign-in attempt expired — try again')
      await sb.from('webauthn_challenges').delete().eq('id', row.id)
      if (Date.now() - new Date(row.created_at).getTime() > CHALLENGE_TTL_MS) {
        throw new Error('That sign-in attempt expired — try again')
      }
      return row
    }

    // Read the challenge the browser echoed back, WITHOUT trusting it: it only
    // selects which server-issued challenge row to consume; verify*() then
    // checks the signed client data against that row's value.
    const echoedChallenge = (clientDataJSON: string) => {
      const cd = JSON.parse(new TextDecoder().decode(b64uToBytes(String(clientDataJSON || ''))))
      return String(cd.challenge || '')
    }

    // ── REGISTER (needs a session: you add a passkey to your own account) ────
    if (action === 'register_options') {
      const user = await requireUser()
      const challenge = await newChallenge('register', user.id)
      const { data: existing } = await sb.from('user_passkeys')
        .select('credential_id, transports').eq('user_id', user.id)
      return json({
        ok: true,
        options: {
          challenge,
          rp: { name: 'PartVault', id: rpID },
          user: { id: bytesToB64u(new TextEncoder().encode(user.id)), name: user.email, displayName: user.email },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',   // Face ID / Touch ID / Hello, not a USB key
            residentKey: 'required',               // discoverable: sign in with nothing typed
            requireResidentKey: true,
            userVerification: 'required',          // the biometric IS the point
          },
          // Don't let one device register twice under the same account.
          excludeCredentials: (existing || []).map((c: any) => ({
            type: 'public-key', id: c.credential_id, transports: c.transports || undefined,
          })),
          timeout: 60000,
          attestation: 'none',
        },
      })
    }

    if (action === 'register_verify') {
      const user = await requireUser()
      const { rawId, response, label } = body.credential || {}
      if (!rawId || !response?.clientDataJSON || !response?.attestationObject) throw new Error('Incomplete passkey')

      const chRow = await consumeChallenge(echoedChallenge(response.clientDataJSON), 'register')
      if (chRow.user_id !== user.id) throw new Error('That sign-in attempt expired — try again')

      const cred = await verifyRegistration({
        clientDataJSON: response.clientDataJSON,
        attestationObject: response.attestationObject,
        expectedChallenge: chRow.challenge,
        allowedOrigins: ALLOWED_ORIGINS,
      })
      if (cred.credentialId !== String(rawId)) throw new Error('Passkey id mismatch')

      const { error } = await sb.from('user_passkeys').insert({
        user_id: user.id,
        credential_id: cred.credentialId,
        public_key: cred.publicKey,
        counter: cred.counter,
        transports: response.transports || null,
        device_label: String(label || '').slice(0, 60) || 'This device',
      })
      if (error) throw new Error(/duplicate|unique/i.test(error.message) ? 'This device already has a passkey' : error.message)
      return json({ ok: true, credentialId: cred.credentialId, version: FN_VERSION })
    }

    // ── AUTHENTICATE (no session — this IS the sign-in) ──────────────────────
    if (action === 'auth_options') {
      const challenge = await newChallenge('auth', null)
      return json({
        ok: true,
        options: {
          challenge,
          rpId: rpID,
          allowCredentials: [],          // discoverable: the device offers what it holds
          userVerification: 'required',
          timeout: 60000,
        },
      })
    }

    if (action === 'auth_verify') {
      const { rawId, response } = body.credential || {}
      if (!rawId || !response?.clientDataJSON || !response?.authenticatorData || !response?.signature) {
        throw new Error('Incomplete passkey response')
      }
      const chRow = await consumeChallenge(echoedChallenge(response.clientDataJSON), 'auth')

      const { data: cred } = await sb.from('user_passkeys')
        .select('*').eq('credential_id', String(rawId)).maybeSingle()
      if (!cred) throw new Error('This device is not set up for Face ID sign-in')

      const res = await verifyAssertion({
        clientDataJSON: response.clientDataJSON,
        authenticatorData: response.authenticatorData,
        signature: response.signature,
        publicKey: cred.public_key,
        expectedChallenge: chRow.challenge,
        allowedOrigins: ALLOWED_ORIGINS,
        storedCounter: Number(cred.counter) || 0,
      })

      const { data: u } = await sb.auth.admin.getUserById(cred.user_id)
      if (!u?.user?.email) throw new Error('That account no longer exists')
      const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: 'magiclink', email: u.user.email })
      const tokenHash = link?.properties?.hashed_token
      if (linkErr || !tokenHash) throw new Error(`Could not sign in: ${linkErr?.message || 'no token'}`)

      await sb.from('user_passkeys')
        .update({ counter: res.counter, last_used_at: new Date().toISOString() })
        .eq('id', cred.id)

      return json({ ok: true, tokenHash, email: u.user.email })
    }

    // ── MANAGE ───────────────────────────────────────────────────────────────
    if (action === 'list') {
      const user = await requireUser()
      const { data } = await sb.from('user_passkeys')
        .select('id, device_label, created_at, last_used_at').eq('user_id', user.id).order('created_at')
      return json({ ok: true, passkeys: data || [] })
    }

    if (action === 'delete') {
      const user = await requireUser()
      const { error } = await sb.from('user_passkeys').delete().eq('id', String(body.id || '')).eq('user_id', user.id)
      if (error) throw new Error(error.message)
      return json({ ok: true })
    }

    if (action === 'version') return json({ ok: true, version: FN_VERSION })

    throw new Error(`Unknown action: ${action}`)
  } catch (e) {
    return json({ error: (e as Error).message || 'Passkey error' }, 400)
  }
})
