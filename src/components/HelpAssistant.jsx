import { useState } from 'react'
import { C, S } from '../lib/constants'
import { sb } from '../lib/supabase'

const FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess'

// AI help assistant — quick answers to how-to questions from PartVault help
// knowledge. Hands off to "Message us" when it can't help.
export default function HelpAssistant({ storeId }) {
  const [msgs, setMsgs] = useState([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  const ask = async () => {
    const question = q.trim()
    if (!question || busy) return
    const history = msgs.slice(-6)
    setMsgs(m => [...m, { role: 'user', content: question }])
    setQ(''); setBusy(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ mode: 'help', question, storeId, history }),
      })
      const d = await res.json()
      setMsgs(m => [...m, { role: 'assistant', content: d.answer || "Sorry, I couldn't answer that — try Message us below." }])
    } catch {
      setMsgs(m => [...m, { role: 'assistant', content: 'Something went wrong — please use Message us below.' }])
    }
    setBusy(false)
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Ask a quick question and the assistant will answer from PartVault's help. For anything it can't solve, use <b>Message us</b> below.</div>
      {msgs.length > 0 && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, maxHeight: 300, overflowY: 'auto', marginBottom: 10 }}>
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
