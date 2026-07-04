import { useState, useEffect } from 'react'
import { C, S } from '../lib/constants'
import { sbOps } from '../lib/supabaseOps'
import SystemAdmin from './SystemAdmin'

// Standalone superadmin console — its OWN login, on an isolated (in-memory)
// Supabase session, so it's completely separate from the customer admin app.
// Access requires: valid sign-in + is_platform_admin() true (server) + RLS.
export default function SuperAdmin() {
  const [phase, setPhase] = useState('checking') // checking | login | denied | ok
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
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
  const signOut = async () => { await sbOps.auth.signOut(); setEmail(''); setPw(''); setPhase('login') }

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

  return (
    <Center>
      <div style={{ ...S.card, maxWidth: 360, width: '100%' }}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>🛠️ PartVault Ops</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>Platform administration — authorised staff only.</div>
        <input style={{ ...S.input, marginBottom: 10 }} type="email" placeholder="Email" value={email} autoFocus
          onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && document.getElementById('ops-pw')?.focus()} />
        <input id="ops-pw" style={{ ...S.input, marginBottom: 10 }} type="password" placeholder="Password" value={pw}
          onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && email && pw && login()} />
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{err}</div>}
        <button style={{ ...S.btn('primary'), width: '100%' }} onClick={login} disabled={busy || !email || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </Center>
  )
}

function Center({ children }) {
  return <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>{children}</div>
}
