import { useState } from 'react'
import { C } from '../lib/constants'

// ════════════════════════════════════════════════════════════════════════════
// A section that collapses on a phone and stays open on a desktop.
//
// Measured 2026-09-01 at 390x844: Sales put 1,552px of chart and summary panels
// above the first sale — nearly two full screens, 13 controls, and 0% of the
// first viewport was the thing you opened the screen for. Inventory was 478px
// and 12 controls. The panels are all useful; on a phone they are just not what
// you came for, and they were not optional.
//
// So: heading, tap to open. Two rules make it work rather than just hide things.
//
//   1. THE HEADING CARRIES THE ANSWER. A collapsed section shows its headline
//      value in the heading — "Performance $1,248" — so the number survives even
//      when the chart does not. Collapsing something to a bare title just moves
//      the information further away.
//   2. THE CHOICE STICKS. Open state is remembered per section in localStorage,
//      so someone who does want the chart every time opens it once.
//
// Desktop is untouched: `on` is false there and the children render bare, with
// no heading and no wrapper, so nothing about the desktop layout shifts.
// ════════════════════════════════════════════════════════════════════════════

const KEY = 'pv-sec'

const read = (id, dflt) => {
  try {
    const v = localStorage.getItem(`${KEY}:${id}`)
    return v == null ? dflt : v === '1'
  } catch { return dflt }
}
const write = (id, open) => {
  try { localStorage.setItem(`${KEY}:${id}`, open ? '1' : '0') } catch { /* private window */ }
}

/**
 * @param {string}  id       stable key for remembering open/closed
 * @param {string}  title    heading text
 * @param {node}    summary  the headline value, shown in the heading — this is
 *                           what stops collapsing from losing information
 * @param {boolean} on       collapse at all (pass isMobile)
 * @param {boolean} openByDefault
 */
export default function MobileSection({ id, title, summary, on, openByDefault = false, children }) {
  const [open, setOpen] = useState(() => (on ? read(id, openByDefault) : true))
  if (!on) return children

  const toggle = () => { const next = !open; setOpen(next); write(id, next) }
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
      <button
        onClick={toggle}
        aria-expanded={open}
        style={{
          width: '100%', minHeight: 48, display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' }}>{title}</span>
        {/* The value the section is about, kept visible while it is shut. */}
        {summary != null && (
          <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summary}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span aria-hidden="true" style={{
          fontSize: 12, color: C.muted, flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s',
        }}>▾</span>
      </button>
      {open && <div style={{ padding: '0 14px 14px' }}>{children}</div>}
    </div>
  )
}
