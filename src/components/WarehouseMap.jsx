import { C } from '../lib/constants'
import { warehouseConfig, partCoords } from '../lib/warehouse'

// A top-down floor plan of the warehouse: rows (aisles) down the page, bays
// across. Optionally highlights one part's cell and notes its shelf/level.
// Purely presentational — pass the store's warehouse config + (optional) part.
export default function WarehouseMap({ warehouse, part, compact = false }) {
  const cfg = warehouseConfig(warehouse)
  const rows = Math.max(0, Math.min(40, cfg.rows | 0))
  const bays = Math.max(0, Math.min(40, cfg.bays | 0))
  if (!rows || !bays) return null

  const c = part ? partCoords(part) : { row: null, bay: null, shelf: null }
  const cell = compact ? 16 : 26
  const gap = compact ? 2 : 3

  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <div style={{ display: 'inline-grid', gridTemplateColumns: `auto repeat(${bays}, ${cell}px)`, gap, alignItems: 'center' }}>
        {/* header row: corner + bay numbers */}
        <div />
        {Array.from({ length: bays }, (_, b) => (
          <div key={`h${b}`} style={{ fontSize: compact ? 8 : 10, color: C.muted, textAlign: 'center' }}>{b + 1}</div>
        ))}
        {Array.from({ length: rows }, (_, r) => {
          const rowN = r + 1
          return [
            <div key={`r${r}`} style={{ fontSize: compact ? 8 : 10, color: C.muted, paddingRight: 4, textAlign: 'right' }}>{cfg.rowLabel?.[0] || 'R'}{rowN}</div>,
            ...Array.from({ length: bays }, (_, b) => {
              const bayN = b + 1
              const hit = c.row === rowN && c.bay === bayN
              return (
                <div key={`c${r}-${b}`} title={`${cfg.rowLabel} ${rowN} · ${cfg.bayLabel} ${bayN}`}
                  style={{
                    width: cell, height: cell, borderRadius: 4,
                    background: hit ? C.accent : '#f1f3f5',
                    border: `1px solid ${hit ? C.accent : C.border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: hit ? '#fff' : 'transparent', fontSize: compact ? 8 : 10, fontWeight: 700,
                    boxShadow: hit ? `0 0 0 2px ${C.accent}44` : 'none',
                  }}>
                  {hit && c.shelf != null ? c.shelf : (hit ? '●' : '')}
                </div>
              )
            }),
          ]
        })}
      </div>
    </div>
  )
}
