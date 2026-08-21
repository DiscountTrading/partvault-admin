import { useState } from 'react'
import { sb, EDGE_FN } from '../lib/supabase'
import { C, S } from '../lib/constants'
import { MARKETPLACE_LIST, guessMarketplace } from '../lib/marketplaces'
import { SOURCING_MODES } from '../lib/constants'


// First screen after signup, before the user belongs to any store. Two paths:
//  • CREATE a store — just a name, no eBay account or personal data needed. By
//    default it's seeded with clearly-flagged sample data so every tab has
//    something to explore; a banner in the app removes it all in one click.
//  • JOIN an existing store with a code from its owner.
export default function JoinStore({ onJoined, onSignOut }) {
  const [view, setView] = useState('create') // 'create' | 'join'
  const [name, setName] = useState('')
  const [marketplace, setMarketplace] = useState(guessMarketplace)
  const [sourcing, setSourcing] = useState('dismantle')
  const [withSample, setWithSample] = useState(true)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyMsg, setBusyMsg] = useState('')
  const [err, setErr] = useState('')

  const create = async () => {
    if (!name.trim()) return
    setBusy(true); setErr('')
    try {
      setBusyMsg('Creating your store…')
      const { data: storeId, error } = await sb.rpc('create_store', { p_name: name.trim() })
      if (error) throw error
      // Stamp the confirmed marketplace + browser timezone (locks once the first
      // real part is created — sample data doesn't lock it).
      let tz = ''
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { /* optional */ }
      // New stores start with no cost applied to parts (costing.enabled=false) —
      // pure eBay revenue until the seller opts in from Settings → Costs.
      await sb.from('stores').update({ settings: { marketplace, sourcing, costing: { enabled: false }, ...(tz ? { timezone: tz } : {}) } }).eq('id', storeId)
      if (withSample) {
        setBusyMsg('Loading sample data…')
        try {
          const { data: { session } } = await sb.auth.getSession()
          const res = await fetch(EDGE_FN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ action: 'seed_sample_data', storeId, sourcing }),
          })
          const d = await res.json()
          if (!res.ok || d.error) throw new Error(d.error || 'seed failed')
        } catch (e) {
          // Non-fatal: the store still works, just starts empty.
          console.error('Sample seed failed:', e.message)
        }
      }
      onJoined(storeId)
    } catch (e) { setErr(e.message); setBusy(false); setBusyMsg('') }
  }

  const join = async () => {
    if (!code.trim()) return
    setBusy(true); setErr('')
    const { data, error } = await sb.rpc('join_store', { p_join_code: code.trim() })
    setBusy(false)
    if (error) { setErr(error.message); return }
    onJoined(data)
  }

  const tabBtn = (id, label) => (
    <button type="button" onClick={() => { setView(id); setErr('') }}
      style={{ flex: 1, padding: '9px 0', fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer', borderRadius: 8,
        background: view === id ? C.accent : 'transparent', color: view === id ? '#fff' : C.muted }}>
      {label}
    </button>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#f5f4f0,#edeae3)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🏪</div>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "'Inter Tight',system-ui,sans-serif", color: C.text }}>Welcome to PartVault</div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 6, lineHeight: 1.6 }}>Set up your own store in seconds — no eBay account needed — or join a team you've been invited to.</div>
        </div>
        <div style={S.card}>
          <div style={{ display: 'flex', gap: 4, background: C.panel, borderRadius: 10, padding: 4, marginBottom: 18 }}>
            {tabBtn('create', '✨ Create my store')}
            {tabBtn('join', '🤝 Join with a code')}
          </div>

          {view === 'create' ? (
            <>
              <label style={S.label}>Store name</label>
              <input style={S.input} value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && create()} placeholder="e.g. Smith's Auto Parts" autoFocus />
              <label style={{ ...S.label, marginTop: 12 }}>Where do you sell?</label>
              <select style={{ ...S.input, background: '#fff' }} value={marketplace} onChange={e => setMarketplace(e.target.value)}>
                {MARKETPLACE_LIST.map(m => <option key={m.id} value={m.id}>{m.flag} {m.label} · {m.currency}</option>)}
              </select>
              <label style={{ ...S.label, marginTop: 12 }}>How do you get your parts?</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.values(SOURCING_MODES).map(m => (
                  <label key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', border: `1.5px solid ${sourcing === m.id ? C.accent : C.border}`, background: sourcing === m.id ? C.accentSoft : '#fff', borderRadius: 10, padding: '10px 12px' }}>
                    <input type="radio" name="sourcing" checked={sourcing === m.id} onChange={() => setSourcing(m.id)} style={{ marginTop: 3 }} />
                    <span style={{ fontSize: 13, color: C.text, lineHeight: 1.4 }}><strong>{m.label}</strong><br /><span style={{ color: C.muted }}>{m.blurb}</span></span>
                  </label>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 14, cursor: 'pointer', fontSize: 13, color: C.text, lineHeight: 1.5 }}>
                <input type="checkbox" checked={withSample} onChange={e => setWithSample(e.target.checked)} style={{ marginTop: 2 }} />
                <span><strong>Start with sample data</strong> — 3 demo cars, 22 parts and some sales so you can explore every screen straight away. Clearly labelled, removable with one click, and it never touches eBay.</span>
              </label>
              {err && <div style={{ fontSize: 13, color: C.red, margin: '12px 0 0' }}>{err}</div>}
              <button style={{ ...S.btn(), width: '100%', padding: 14, fontSize: 15, marginTop: 16, opacity: (busy || !name.trim()) ? 0.6 : 1 }}
                onClick={create} disabled={busy || !name.trim()}>
                {busy ? `⏳ ${busyMsg || 'Working…'}` : '🚀 Create store'}
              </button>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 12, lineHeight: 1.6 }}>
                You can connect your eBay account later in Settings — nothing here requires it.
              </div>
            </>
          ) : (
            <>
              <label style={S.label}>Join code</label>
              <input style={{ ...S.input, fontSize: 18, fontWeight: 700, letterSpacing: 2, textAlign: 'center', fontFamily: 'monospace' }}
                value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && join()}
                placeholder="JOIN CODE" autoFocus />
              {err && <div style={{ fontSize: 13, color: C.red, margin: '12px 0 0' }}>{err}</div>}
              <button style={{ ...S.btn(), width: '100%', padding: 14, fontSize: 15, marginTop: 14, opacity: (busy || !code.trim()) ? 0.6 : 1 }}
                onClick={join} disabled={busy || !code.trim()}>
                {busy ? '⏳ Joining…' : 'Join Store'}
              </button>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 12, lineHeight: 1.6 }}>
                💡 Don't have a code? Ask your store owner — they'll find it under Settings → User Access.
              </div>
            </>
          )}
          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <span style={{ color: C.muted, cursor: 'pointer', fontSize: 13 }} onClick={onSignOut}>Sign Out</span>
          </div>
        </div>
      </div>
    </div>
  )
}
