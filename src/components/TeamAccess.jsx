import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'

const CAPS = [
  ['add_edit', 'Add / Edit'],
  ['delete', 'Delete'],
  ['publish', 'Publish to eBay'],
  ['settings', 'Settings'],
  ['manage_users', 'Manage Users'],
]

const PRESETS = {
  Worker: { add_edit: true },
  Admin: { add_edit: true, delete: true, publish: true, settings: true, manage_users: true },
}

function Section({ title, children }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      {title && <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 14 }}>{title}</div>}
      {children}
    </div>
  )
}

export default function TeamAccess({ storeId }) {
  const [members, setMembers] = useState([])
  const [edited, setEdited] = useState({})   // user_id -> permissions draft
  const [joinCode, setJoinCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [noAccess, setNoAccess] = useState(false)
  const [savingId, setSavingId] = useState(null)
  const [toast, setToast] = useState('')

  const load = async () => {
    setLoading(true); setNoAccess(false)
    const { data, error } = await sb.rpc('get_store_members', { p_store_id: storeId })
    if (error) { setNoAccess(true); setLoading(false); return }
    const list = data || []
    if (list.length === 0) { setNoAccess(true); setLoading(false); return }
    setMembers(list)
    setEdited(Object.fromEntries(list.map(m => [m.user_id, { ...(m.permissions || {}) }])))
    const { data: store } = await sb.from('stores').select('join_code').eq('id', storeId).single()
    setJoinCode(store?.join_code || '')
    setLoading(false)
  }

  useEffect(() => { load() }, [storeId])

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2000) }

  const toggle = (uid, cap) => setEdited(e => ({ ...e, [uid]: { ...e[uid], [cap]: !e[uid]?.[cap] } }))
  const applyPreset = (uid, preset) => setEdited(e => ({ ...e, [uid]: { ...PRESETS[preset] } }))

  const save = async (uid) => {
    setSavingId(uid)
    const { error } = await sb.rpc('set_member_permissions', { p_store_id: storeId, p_user_id: uid, p_permissions: edited[uid] })
    setSavingId(null)
    if (error) { flash(`✗ ${error.message}`); return }
    flash('✓ Saved')
    load()
  }

  const removeMember = async (uid, email) => {
    if (!confirm(`Remove ${email} from this store? They'll lose all access.`)) return
    const { error } = await sb.rpc('remove_member', { p_store_id: storeId, p_user_id: uid })
    if (error) { flash(`✗ ${error.message}`); return }
    flash('✓ Removed')
    load()
  }

  const dirty = (uid) => {
    const orig = members.find(m => m.user_id === uid)?.permissions || {}
    const cur = edited[uid] || {}
    return CAPS.some(([k]) => !!orig[k] !== !!cur[k])
  }

  if (loading) return <div style={{ color: C.muted, padding: 20 }}>Loading…</div>
  if (noAccess) return (
    <Section title="User Access">
      <div style={{ fontSize: 14, color: C.muted }}>You don't have permission to manage users for this store.</div>
    </Section>
  )

  return (
    <>
      <Section title="Invite someone">
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Share this store's join code. A new person creates their own PartVault account, enters the code, and joins as a worker (Add/Edit only) — you then grant more below.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 20, fontWeight: 800, letterSpacing: '2px', color: C.text, background: '#f4f4f5', borderRadius: 8, padding: '8px 16px' }}>{joinCode || '—'}</span>
          <button onClick={() => { navigator.clipboard?.writeText(joinCode); flash('✓ Copied') }} style={{ ...S.btn('secondary'), padding: '8px 14px' }}>Copy</button>
        </div>
      </Section>

      <Section title="User Access">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: C.muted, fontWeight: 700 }}>User</th>
                {CAPS.map(([k, label]) => <th key={k} style={{ padding: '8px 6px', color: C.muted, fontWeight: 700, fontSize: 11 }}>{label}</th>)}
                <th style={{ padding: '8px 6px', color: C.muted, fontWeight: 700, fontSize: 11 }}>Quick set</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.map(m => {
                const isOwner = m.role === 'owner'
                const perms = isOwner
                  ? Object.fromEntries(CAPS.map(([k]) => [k, true]))
                  : (edited[m.user_id] || {})
                return (
                  <tr key={m.user_id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '10px', minWidth: 180 }}>
                      <div style={{ fontWeight: 600, color: C.text }}>{m.name || m.email}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>{m.email}{isOwner ? ' · owner' : ''}</div>
                    </td>
                    {CAPS.map(([k]) => (
                      <td key={k} style={{ textAlign: 'center', padding: '10px 6px' }}>
                        <input type="checkbox" checked={!!perms[k]} disabled={isOwner}
                          onChange={() => toggle(m.user_id, k)}
                          style={{ width: 18, height: 18, cursor: isOwner ? 'not-allowed' : 'pointer' }} />
                      </td>
                    ))}
                    <td style={{ textAlign: 'center', padding: '10px 6px', whiteSpace: 'nowrap' }}>
                      {isOwner ? <span style={{ color: C.muted, fontSize: 11 }}>full</span> : (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          {Object.keys(PRESETS).map(p => (
                            <button key={p} onClick={() => applyPreset(m.user_id, p)}
                              style={{ fontSize: 11, padding: '3px 8px', border: `1px solid ${C.border}`, borderRadius: 6, background: '#fff', cursor: 'pointer', color: C.text }}>{p}</button>
                          ))}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', padding: '10px 6px', whiteSpace: 'nowrap' }}>
                      {!isOwner && (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button onClick={() => save(m.user_id)} disabled={!dirty(m.user_id) || savingId === m.user_id}
                            style={{ ...S.btn(dirty(m.user_id) ? 'primary' : 'secondary'), padding: '5px 12px', fontSize: 12, opacity: (!dirty(m.user_id) || savingId === m.user_id) ? 0.5 : 1 }}>
                            {savingId === m.user_id ? '…' : 'Save'}
                          </button>
                          <button onClick={() => removeMember(m.user_id, m.email)}
                            style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 12, color: C.red, borderColor: C.red }}>Remove</button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {toast && <div style={{ position: 'fixed', bottom: 24, right: 24, background: C.text, color: '#fff', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 1000 }}>{toast}</div>}
    </>
  )
}
