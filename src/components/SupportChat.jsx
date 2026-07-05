import { useState, useEffect } from 'react'
import { C, S } from '../lib/constants'
import { sb } from '../lib/supabase'
import { createTicket, replyTicket, setTicketStatus, myThreads, threadMessages } from '../lib/support'

// Support messaging UI. staff=false → customer "Message us" (in Settings).
// staff=true → ops inbox (in the superadmin console). `client` lets the ops
// console pass its isolated session (sbOps); defaults to the admin session.
export default function SupportChat({ staff = false, storeId, client = sb }) {
  const [threads, setThreads] = useState([])
  const [openId, setOpenId] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // New-ticket (customer) form
  const [newSubject, setNewSubject] = useState('')
  const [newBody, setNewBody] = useState('')

  const loadThreads = async () => setThreads(await myThreads(client))
  useEffect(() => { loadThreads() }, [])
  useEffect(() => { if (openId) threadMessages(client, openId).then(setMsgs) }, [openId])

  const open = async (id) => { setOpenId(id); setMsgs(await threadMessages(client, id)) }
  const send = async () => {
    if (!reply.trim() || !openId) return
    setBusy(true); setErr('')
    try { await replyTicket(client, openId, reply.trim()); setReply(''); setMsgs(await threadMessages(client, openId)); loadThreads() }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  const startTicket = async () => {
    if (!newBody.trim()) return
    setBusy(true); setErr('')
    try {
      const { threadId } = await createTicket(client, newSubject.trim() || 'Support request', newBody.trim(), storeId)
      setNewSubject(''); setNewBody(''); await loadThreads(); open(threadId)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  const toggleStatus = async (t) => { await setTicketStatus(client, t.id, t.status === 'open' ? 'closed' : 'open'); loadThreads() }

  const bubble = (m) => {
    const mine = staff ? m.sender === 'staff' : m.sender === 'customer'
    return (
      <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
        <div style={{ maxWidth: '78%', background: mine ? C.accent : '#fff', color: mine ? '#fff' : C.text, border: mine ? 'none' : `1px solid ${C.border}`, borderRadius: 12, padding: '8px 12px', fontSize: 14, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
          {m.body}
          <div style={{ fontSize: 10, opacity: 0.65, marginTop: 4 }}>{m.sender === 'staff' ? 'PartVault' : 'Customer'} · {new Date(m.created_at).toLocaleString()}</div>
        </div>
      </div>
    )
  }

  // Conversation view
  if (openId) {
    const t = threads.find(x => x.id === openId)
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button style={{ ...S.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={() => { setOpenId(null); loadThreads() }}>← Back</button>
          <div style={{ fontWeight: 700, color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t?.subject}{staff && t?.email ? ` · ${t.email}` : ''}</div>
          {staff && t && <button style={{ ...S.btn('secondary'), padding: '6px 12px', fontSize: 12 }} onClick={() => toggleStatus(t)}>{t.status === 'open' ? 'Mark resolved' : 'Reopen'}</button>}
        </div>
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, minHeight: 200, maxHeight: 380, overflowY: 'auto', marginBottom: 10 }}>
          {msgs.map(bubble)}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea style={{ ...S.textarea, minHeight: 44, flex: 1 }} rows={2} value={reply} onChange={e => setReply(e.target.value)} placeholder={staff ? 'Reply to customer…' : 'Type a message…'} />
          <button style={S.btn('primary')} onClick={send} disabled={busy || !reply.trim()}>Send</button>
        </div>
        {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
      </div>
    )
  }

  // List view
  return (
    <div>
      {!staff && (
        <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 8 }}>💬 Message us</div>
          <input style={{ ...S.input, marginBottom: 8 }} value={newSubject} onChange={e => setNewSubject(e.target.value)} placeholder="Subject (optional)" />
          <textarea style={{ ...S.textarea, marginBottom: 8 }} rows={3} value={newBody} onChange={e => setNewBody(e.target.value)} placeholder="How can we help? We'll reply by email and here." />
          <button style={S.btn('primary')} onClick={startTicket} disabled={busy || !newBody.trim()}>{busy ? 'Sending…' : 'Send message'}</button>
          {err && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{err}</div>}
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, marginBottom: 8 }}>{staff ? 'All conversations' : 'Your conversations'}</div>
      {threads.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>No messages yet.</div>}
      {threads.map(t => (
        <button key={t.id} onClick={() => open(t.id)}
          style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 10, alignItems: 'center', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8, cursor: 'pointer' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{staff && t.email ? `${t.email} · ` : ''}{new Date(t.updated_at).toLocaleDateString()}{t.last_sender === 'customer' && staff ? ' · awaiting reply' : ''}</div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: t.status === 'open' ? C.accent : C.muted }}>{t.status === 'open' ? 'Open' : 'Resolved'}</span>
        </button>
      ))}
    </div>
  )
}
