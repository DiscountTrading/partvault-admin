import { useState, useEffect, useCallback } from 'react'
import { C, S } from '../lib/constants'
import SupportChat from './SupportChat'

// Platform Ops console body. Used ONLY by the standalone ops console
// (src/ops.jsx) on its isolated session. Server-side the real lock is
// is_platform_admin() inside every ops_* RPC + RLS on system_settings —
// this UI simply surfaces them so stores, users and access are managed
// here instead of the Supabase dashboard.
const ROLES = ['owner', 'member', 'worker']

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const fmtAgo = d => {
  if (!d) return 'never'
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000)
  if (mins < 60) return `${Math.max(mins, 0)}m ago`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

const th = { textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: `2px solid ${C.border}`, whiteSpace: 'nowrap' }
const td = { padding: '7px 10px', fontSize: 12.5, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }

function StoresTab({ client }) {
  const [stores, setStores] = useState(null)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState(null)      // store whose members panel is open
  const [members, setMembers] = useState(null)
  const [addEmail, setAddEmail] = useState('')
  const [addRole, setAddRole] = useState('member')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await client.rpc('ops_list_stores')
    if (error) setErr(error.message); else setStores(data || [])
  }, [client])
  useEffect(() => { load() }, [load])

  const loadMembers = async (storeId) => {
    setOpenId(storeId); setMembers(null); setAddEmail(''); setAddRole('member')
    const { data, error } = await client.rpc('ops_store_members', { p_store_id: storeId })
    if (error) setErr(error.message); else setMembers(data || [])
  }

  // One wrapper for every membership mutation: run, surface the DB's own
  // plain-language error (last-owner guard etc.), refresh both panels.
  const act = async (fn) => {
    setBusy(true); setErr('')
    try {
      const { error } = await fn()
      if (error) throw error
      await loadMembers(openId); await load()
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  if (err && !stores) return <div style={{ color: C.red, fontSize: 13 }}>{err}</div>
  if (!stores) return <div style={{ color: C.muted }}>Loading stores…</div>

  return (
    <div>
      {err && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{err}</div>}
      <div style={{ ...S.card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Store</th><th style={th}>Tier</th><th style={th}>Market</th><th style={th}>eBay</th>
            <th style={{ ...th, textAlign: 'right' }}>Members</th><th style={{ ...th, textAlign: 'right' }}>Parts</th>
            <th style={{ ...th, textAlign: 'right' }}>Live</th><th style={{ ...th, textAlign: 'right' }}>Sales</th>
            <th style={th}>Created</th><th style={th}>Join code</th><th style={th}>Status</th>
          </tr></thead>
          <tbody>
            {stores.map(s => (
              <tr key={s.id} onClick={() => openId === s.id ? setOpenId(null) : loadMembers(s.id)}
                style={{ cursor: 'pointer', background: openId === s.id ? '#f0f7ff' : 'transparent' }}
                title="Click to manage this store's members">
                <td style={{ ...td, fontWeight: 700 }}>{openId === s.id ? '▾ ' : '▸ '}{s.name}{s.sample ? ' 🧪' : ''}</td>
                <td style={td}>{s.subscription_tier || '—'}</td>
                <td style={td}>{(s.marketplace || '').replace('EBAY_', '') || '—'}</td>
                <td style={td}>{s.ebay_connected ? `✓ ${s.ebay_user || ''}` : '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{s.members}</td>
                <td style={{ ...td, textAlign: 'right' }}>{(+s.parts).toLocaleString()}</td>
                <td style={{ ...td, textAlign: 'right' }}>{(+s.live_listings).toLocaleString()}</td>
                <td style={{ ...td, textAlign: 'right' }}>{(+s.sales).toLocaleString()}</td>
                <td style={td}>{fmtDate(s.created_at)}</td>
                <td style={{ ...td, fontFamily: 'monospace' }}>{s.join_code || '—'}</td>
                <td style={td}>{s.deleted_at
                  ? <span style={{ color: C.red, fontWeight: 700 }}>deleted{s.grace_until ? ` · grace to ${fmtDate(s.grace_until)}` : ''}</span>
                  : <span style={{ color: C.green, fontWeight: 700 }}>active</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openId && (
        <div style={{ ...S.card, marginTop: 14 }}>
          <h2 style={S.h2}>Members — {stores.find(s => s.id === openId)?.name}</h2>
          {!members ? <div style={{ color: C.muted, fontSize: 13 }}>Loading members…</div> : (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
                <thead><tr><th style={th}>Email</th><th style={th}>Role</th><th style={th}>Last sign-in</th><th style={th}>Joined</th><th style={th}></th></tr></thead>
                <tbody>
                  {members.map(m => (
                    <tr key={m.user_id}>
                      <td style={td}>{m.email}</td>
                      <td style={td}>
                        <select value={m.role} disabled={busy}
                          onChange={e => act(() => client.rpc('ops_set_member_role', { p_store_id: openId, p_user_id: m.user_id, p_role: e.target.value }))}
                          style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 8px', fontSize: 12, background: '#fff' }}>
                          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td style={td}>{fmtAgo(m.last_sign_in_at)}</td>
                      <td style={td}>{fmtDate(m.created_at)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <button disabled={busy}
                          onClick={() => confirm(`Remove ${m.email} from this store?\n\nThey keep their account but lose all access to the store.`) &&
                            act(() => client.rpc('ops_remove_member', { p_store_id: openId, p_user_id: m.user_id }))}
                          style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 10px', fontSize: 12, color: C.red, cursor: 'pointer' }}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input style={{ ...S.input, maxWidth: 260, margin: 0 }} type="email" placeholder="user@email.com"
                  value={addEmail} onChange={e => setAddEmail(e.target.value)} />
                <select value={addRole} onChange={e => setAddRole(e.target.value)}
                  style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, background: '#fff' }}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <button style={S.btn('primary')} disabled={busy || !addEmail.trim()}
                  onClick={() => act(() => client.rpc('ops_add_member', { p_store_id: openId, p_email: addEmail.trim(), p_role: addRole }))
                    .then(() => setAddEmail(''))}>
                  + Add member
                </button>
                <span style={{ fontSize: 11.5, color: C.muted }}>They must already have a PartVault account (any store or none).</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function UsersTab({ client }) {
  const [users, setUsers] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    client.rpc('ops_list_users').then(({ data, error }) => error ? setErr(error.message) : setUsers(data || []))
  }, [client])

  if (err) return <div style={{ color: C.red, fontSize: 13 }}>{err}</div>
  if (!users) return <div style={{ color: C.muted }}>Loading users…</div>

  const shown = users.filter(u => !q || (u.email || '').toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <input style={{ ...S.input, maxWidth: 320, marginBottom: 12 }} placeholder="🔍 Filter by email…" value={q} onChange={e => setQ(e.target.value)} />
      <div style={{ ...S.card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Email</th><th style={th}>Signed up</th><th style={th}>Last sign-in</th><th style={th}>Stores</th></tr></thead>
          <tbody>
            {shown.map(u => (
              <tr key={u.id}>
                <td style={{ ...td, fontWeight: 600 }}>{u.email}</td>
                <td style={td}>{fmtDate(u.created_at)}</td>
                <td style={td}>{fmtAgo(u.last_sign_in_at)}</td>
                <td style={td}>
                  {(u.memberships || []).length === 0
                    ? <span style={{ color: C.yellow, fontWeight: 600 }}>no store yet</span>
                    : (u.memberships || []).map((m, i) => (
                      <span key={i} style={{ display: 'inline-block', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: '2px 10px', fontSize: 11.5, marginRight: 6 }}>
                        {m.store} · <strong>{m.role}</strong>
                      </span>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
        {users.length.toLocaleString()} account{users.length === 1 ? '' : 's'} · "no store yet" = signed up but never created or joined a store.
        To give someone access, open <strong>Stores</strong>, click the store, and add them by email.
      </div>
    </div>
  )
}

function SettingsTab({ client }) {
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

  if (!s) return <div style={{ color: C.muted }}>Loading system settings…</div>
  return (
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
  )
}

export default function SystemAdmin({ client, onSignOut }) {
  const [tab, setTab] = useState('stores')
  const TABS = [['stores', '🏪 Stores'], ['users', '👥 Users'], ['settings', '⚙️ System'], ['support', '📨 Support']]

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <div style={{ background: C.headerBg, padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ color: '#fff', fontWeight: 800, fontSize: 16 }}>🛠️ PartVault — Platform Ops</div>
        <button style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={onSignOut}>Sign out</button>
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 24px 40px' }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, borderBottom: `1px solid ${C.border}`, paddingBottom: 0 }}>
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '8px 14px', fontSize: 13.5, fontWeight: 700,
                color: tab === id ? C.accent : C.muted, borderBottom: tab === id ? `3px solid ${C.accent}` : '3px solid transparent' }}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'stores' && <StoresTab client={client} />}
        {tab === 'users' && <UsersTab client={client} />}
        {tab === 'settings' && <SettingsTab client={client} />}
        {tab === 'support' && (
          <div style={S.card}>
            <h2 style={S.h2}>📨 Support inbox</h2>
            <SupportChat staff client={client} />
          </div>
        )}
      </div>
    </div>
  )
}
