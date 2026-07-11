import { useState, useRef, useEffect } from 'react'
import { C, S } from '../lib/constants'
import { sb } from '../lib/supabase'

const FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess'

// Keep the Q&A thread across closing the panel, for a rolling 12 hours.
const CHAT_KEY = 'pv_help_chat'
const CHAT_TTL_MS = 12 * 60 * 60 * 1000
const loadSaved = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]')
    const cutoff = Date.now() - CHAT_TTL_MS
    return Array.isArray(raw) ? raw.filter(m => (m.ts || 0) >= cutoff) : []
  } catch { return [] }
}

// AI help assistant — quick answers to how-to questions from PartVault help
// knowledge. Hands off to "Message us" when it can't help. `context` tells the
// AI which page the user is on (for the floating helper); `compact` trims chrome.
export default function HelpAssistant({ storeId, context, compact = false }) {
  const [msgs, setMsgs] = useState(loadSaved)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef(null)

  // Persist the thread (trimmed to the last 12h) so it survives closing the panel.
  useEffect(() => {
    try {
      const cutoff = Date.now() - CHAT_TTL_MS
      localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.filter(m => (m.ts || 0) >= cutoff)))
    } catch { /* ignore */ }
  }, [msgs])

  // Keep the newest message (your question + the answer) in view — scroll the
  // thread to the bottom whenever it changes instead of leaving it at the top.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, busy])

  const ask = async () => {
    const question = q.trim()
    if (!question || busy) return
    const history = msgs.slice(-6)
    setMsgs(m => [...m, { role: 'user', content: question, ts: Date.now() }])
    setQ(''); setBusy(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ mode: 'help', question, storeId, history, context }),
      })
      const d = await res.json()
      setMsgs(m => [...m, { role: 'assistant', content: d.answer || "Sorry, I couldn't answer that — try Message us below.", ts: Date.now() }])
    } catch {
      setMsgs(m => [...m, { role: 'assistant', content: 'Something went wrong — please use Message us below.', ts: Date.now() }])
    }
    setBusy(false)
  }

  return (
    <div>
      {!compact && <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Ask a quick question and the assistant will answer from PartVault's help. For anything it can't solve, use <b>Message us</b>.</div>}
      {msgs.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: C.muted }}>Recent questions · kept 12h</span>
          <button onClick={() => { setMsgs([]); try { localStorage.removeItem(CHAT_KEY) } catch { /* ignore */ } }}
            style={{ background: 'none', border: 'none', color: C.muted, fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}>Clear</button>
        </div>
      )}
      {msgs.length > 0 && (
        <div ref={scrollRef} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, maxHeight: 300, overflowY: 'auto', marginBottom: 10 }}>
          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 8 }}>
              <div style={{ maxWidth: '80%', background: m.role === 'user' ? C.accent : '#fff', color: m.role === 'user' ? '#fff' : C.text, border: m.role === 'user' ? 'none' : `1px solid ${C.border}`, borderRadius: 12, padding: '8px 12px', fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{m.content}</div>
            </div>
          ))}
          {busy && <div style={{ fontSize: 12, color: C.muted }}>Assistant is thinking…</div>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...S.input, flex: 1 }} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask()} placeholder="e.g. How do I list a part to eBay?" />
        <button style={S.btn('primary')} onClick={ask} disabled={busy || !q.trim()}>Ask</button>
      </div>
    </div>
  )
}
