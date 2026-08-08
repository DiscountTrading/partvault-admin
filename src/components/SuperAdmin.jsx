import { useState, useEffect } from 'react'
import { C, S } from '../lib/constants'
import { sbOps } from '../lib/supabaseOps'
import SystemAdmin from './SystemAdmin'

// Standalone superadmin console — its OWN login, on an isolated (in-memory)
// Supabase session, so it's completely separate from the customer admin app.
// Access requires: valid sign-in + is_platform_admin() true (server) + RLS.
export default function SuperAdmin() {
  const [phase, setPhase] = useState('checking') // checking | login | otp | denied | ok
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [otp, setOtp] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const evalSession = async () => {
    const { data: { session } } = await sbOps.auth.getSession()
    if (!session) { setPhase('login'); return }
    const { data: isAdmin } = await sbOps.rpc('is_platform_admin')
    setPhase(isAdmin ? 'ok' : 'denied')
  }
  useEffect(() => { evalSession() }, [])

  const login = async () => {
    setBusy(true); setErr('')
    const { error } = await sbOps.auth.signInWithPassword({ email: email.trim(), password: pw })
    setBusy(false)
    if (error) { setErr('Invalid credentials.'); return }
    setPw(''); await evalSession()
  }
  // Same email-code sign-in as the customer apps — platform admins mostly have
  // no password at all (they only ever used OTP). Never creates an account.
  const sendCode = async () => {
    if (!email.trim()) { setErr('Enter your email first.'); return }
    setBusy(true); setErr('')
    const { error } = await sbOps.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setOtp(''); setPhase('otp')
  }
  const verifyCode = async () => {
    setBusy(true); setErr('')
    const { error } = await sbOps.auth.verifyOtp({ email: email.trim(), token: otp, type: 'email' })
    setBusy(false)
    if (error) { setErr('Wrong or expired code — try again or resend.'); return }
    await evalSession()
  }
  const signOut = async () => { await sbOps.auth.signOut(); setEmail(''); setPw(''); setOtp(''); setPhase('login') }

  if (phase === 'checking') return <Center><span style={{ color: C.muted }}>…</span></Center>

  if (phase === 'ok') return <SystemAdmin client={sbOps} onSignOut={signOut} />

  if (phase === 'denied') return (
    <Center>
      <div style={{ ...S.card, maxWidth: 360, textAlign: 'center' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.red, marginBottom: 8 }}>Not authorised</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>This account is not a platform administrator.</div>
        <button style={S.btn('secondary')} onClick={signOut}>Sign out</button>
      </div>
    </Center>
  )

  if (phase === 'otp') return (
    <Center>
      <div style={{ ...S.card, maxWidth: 360, width: '100%' }}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>🛠️ PartVault Ops</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>We emailed a 6-digit code to <strong style={{ color: C.text }}>{email}</strong>.</div>
        <input style={{ ...S.input, marginBottom: 10, fontSize: 22, letterSpacing: 8, textAlign: 'center', fontWeight: 700 }}
          type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={otp} autoFocus
          onChange={e => { setOtp(e.target.value.replace(/\D/g, '')); setErr('') }}
          onKeyDown={e => e.key === 'Enter' && otp.length === 6 && verifyCode()} />
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{err}</div>}
        <button style={{ ...S.btn('primary'), width: '100%' }} onClick={verifyCode} disabled={busy || otp.length < 6}>{busy ? 'Verifying…' : 'Verify code'}</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 13 }}>
          <span style={{ color: C.muted, cursor: 'pointer' }} onClick={() => { setPhase('login'); setErr('') }}>← Back</span>
          <span style={{ color: C.accent, cursor: 'pointer', fontWeight: 600 }} onClick={sendCode}>Resend code</span>
        </div>
      </div>
    </Center>
  )

  return (
    <Center>
      <div style={{ ...S.card, maxWidth: 360, width: '100%' }}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>🛠️ PartVault Ops</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>Platform administration — authorised staff only.</div>
        <input style={{ ...S.input, marginBottom: 10 }} type="email" placeholder="Email" value={email} autoFocus
          onChange={e => setEmail(e.target.value)} />
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{err}</div>}
        <button style={{ ...S.btn('primary'), width: '100%', marginBottom: 14 }} onClick={sendCode} disabled={busy || !email}>
          {busy ? 'Sending…' : '✉️ Email me a sign-in code'}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11.5, color: C.muted, marginBottom: 12 }}>— or, if you set a password —</div>
        <input id="ops-pw" style={{ ...S.input, marginBottom: 10 }} type="password" placeholder="Password" value={pw}
          onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && email && pw && login()} />
        <button style={{ ...S.btn('secondary'), width: '100%' }} onClick={login} disabled={busy || !email || !pw}>Sign in with password</button>
      </div>
    </Center>
  )
}

function Center({ children }) {
  return <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>{children}</div>
}
