import { useState } from 'react'
import { C, S } from '../lib/constants'
import HelpAssistant from './HelpAssistant'

// Floating help on every page: a ? bubble that opens the AI assistant with the
// CURRENT page as context ("can't find something" just works). Escalation goes
// to the Help tab's Message-us.
export default function FloatingHelp({ storeId, context, onOpenHelp }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {open && (
        <div style={{ position: 'fixed', bottom: 84, right: 24, width: 380, maxWidth: 'calc(100vw - 40px)', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: '0 16px 50px rgba(0,0,0,0.22)', zIndex: 900, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>🤖 Quick help</div>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>✕</button>
          </div>
          <HelpAssistant storeId={storeId} context={context} compact />
          <button onClick={() => { setOpen(false); onOpenHelp?.() }}
            style={{ marginTop: 10, background: 'none', border: 'none', color: C.accent, fontSize: 12, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
            Still stuck? Message us →
          </button>
        </div>
      )}
      <button onClick={() => setOpen(o => !o)} title="Help"
        style={{ position: 'fixed', bottom: 24, right: 24, width: 48, height: 48, borderRadius: '50%', background: open ? C.text : C.accent, color: '#fff', border: 'none', fontSize: 21, fontWeight: 800, cursor: 'pointer', boxShadow: '0 6px 20px rgba(0,0,0,0.25)', zIndex: 901 }}>
        {open ? '✕' : '?'}
      </button>
    </>
  )
}
