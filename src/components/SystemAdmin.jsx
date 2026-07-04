import { useState, useEffect } from 'react'
import { C, S } from '../lib/constants'

// System-wide (platform) settings form. Used ONLY by the standalone ops console
// (src/ops.jsx). Takes its Supabase client so it runs on the isolated ops
// session. The real lock is server-side RLS (system_settings → platform_admins).
export default function SystemAdmin({ client, onSignOut }) {
  const [s, setS] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    client.from('system_settings').select('settings').eq('id', 1).maybeSingle()
      .then(({ data }) => setS(data?.settings || {}))
  }, [client])

  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }))
  const save = async () => {
    setSaving(true); setMsg('')
    const { error } = await client.from('system_settings').update({ settings: s }).eq('id', 1)
    setMsg(error ? `✗ ${error.message}` : 'Saved ✓')
    setSaving(false)
    setTimeout(() => setMsg(''), 2500)
  }

  const field = (label, key, placeholder = '', hint = '', type = 'text') => (
    <div style={{ marginBottom: 16 }}>
      <label style={S.label}>{label}</label>
      <input style={{ ...S.input, maxWidth: 420 }} type={type} value={s?.[key] ?? ''} placeholder={placeholder} onChange={e => set(key, e.target.value)} />
      {hint && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <div style={{ background: C.headerBg, padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>🛠️ PartVault — Platform Ops</div>
        <button style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={onSignOut}>Sign out</button>
      </div>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 24px' }}>
        <h1 style={S.h1}>System administration</h1>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Platform-wide settings — apply across all stores, not tied to any subscription.</div>

        {!s ? <div style={{ color: C.muted }}>Loading system settings…</div> : (
          <>
            <div style={{ ...S.card, marginBottom: 20 }}>
              <h2 style={S.h2}>Store-deletion confirmations</h2>
              {field('Purge alert email', 'purgeAlertEmail', 'you@example.com', 'Where the daily "stores awaiting permanent deletion" alert is sent.', 'email')}
              {field('Purge confirmation mobile', 'purgeAlertMobile', '+61…', 'Used for the SMS confirmation before any permanent deletion (once SMS is enabled).', 'tel')}
            </div>
            <div style={{ ...S.card, marginBottom: 20 }}>
              <h2 style={S.h2}>Public support details</h2>
              {field('Support email', 'supportEmail', 'support@partvault.app', 'Shown to customers (site/app) as the support contact.', 'email')}
              {field('Support phone', 'supportPhone', '+61…', 'Optional public support number.', 'tel')}
            </div>
            <div style={{ ...S.card, marginBottom: 20 }}>
              <h2 style={S.h2}>Defaults</h2>
              {field('Free trial length (days)', 'trialDays', '14', 'Informational; new-store trial length.', 'number')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button style={S.btn('primary')} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save system settings'}</button>
              {msg && <span style={{ fontSize: 13, color: msg.startsWith('✗') ? C.red : C.green, fontWeight: 600 }}>{msg}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
