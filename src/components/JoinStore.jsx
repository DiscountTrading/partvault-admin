import { useState } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'

export default function JoinStore({ onJoined, onSignOut }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const join = async () => {
    if (!code.trim()) return
    setBusy(true); setErr('')
    const { data, error } = await sb.rpc('join_store', { p_join_code: code.trim() })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onJoined(data)
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#f5f4f0,#edeae3)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🏪</div>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Inter Tight',system-ui,sans-serif", color: C.text }}>Join a store</div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 6, lineHeight: 1.6 }}>Enter the join code from your store owner to get access.</div>
        </div>
        <div style={S.card}>
          <label style={S.label}>Join code</label>
          <input style={{ ...S.input, fontSize: 18, fontWeight: 700, letterSpacing: 2, textAlign: 'center', fontFamily: 'monospace' }}
            value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && join()}
            placeholder="JOIN CODE" autoFocus />
          {err && <div style={{ fontSize: 13, color: C.red, margin: '12px 0' }}>{err}</div>}
          <button style={{ ...S.btn(), width: '100%', padding: 14, fontSize: 15, marginTop: 14, opacity: (busy || !code.trim()) ? 0.6 : 1 }}
            onClick={join} disabled={busy || !code.trim()}>
            {busy ? '⏳ Joining…' : 'Join Store'}
          </button>
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <span style={{ color: C.muted, cursor: 'pointer', fontSize: 13 }} onClick={onSignOut}>Sign Out</span>
          </div>
        </div>
        <div style={{ ...S.card, marginTop: 14, fontSize: 13, color: C.muted, lineHeight: 1.6, background: C.panel }}>
          💡 Don't have a code? Ask your store owner — they'll find it under Settings → User Access.
        </div>
      </div>
    </div>
  )
}
