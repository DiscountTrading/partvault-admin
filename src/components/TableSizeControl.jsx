import { useState, useEffect } from 'react'
import { ZOOM_OPTIONS, getTableZoom, setTableZoom, applyTableZoom } from '../lib/tableZoom'

// A single global control for how big every data table renders. Lives in the top
// nav; changing it re-scales all tables at once (via the --table-zoom CSS var).
export default function TableSizeControl() {
  const [z, setZ] = useState(getTableZoom())
  useEffect(() => { applyTableZoom(z) }, [z])
  return (
    <label title="Text size for all tables — larger sizes scroll sideways" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>🔎</span>
      <select value={z} onChange={e => { setZ(e.target.value); setTableZoom(e.target.value) }}
        style={{ background: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.9)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: '5px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
        {ZOOM_OPTIONS.map(([v, l]) => <option key={v} value={v} style={{ color: '#000' }}>{l}</option>)}
      </select>
    </label>
  )
}
