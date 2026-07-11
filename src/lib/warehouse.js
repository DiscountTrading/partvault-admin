// Warehouse-grid helpers (Row / Bay / Shelf). The grid is an OPTIONAL, per-store
// structure defined in stores.settings.warehouse; parts carry numeric loc_row/
// loc_bay/loc_shelf coordinates that map onto it. Keep everything framework-free
// so both admin and the mobile PWA can share the same shape.

export const WAREHOUSE_DEFAULTS = {
  enabled: false,
  rows: 0,      // aisles (across)
  bays: 0,      // positions along each row (length)
  shelves: 0,   // levels (height)
  rowLabel: 'Row',
  bayLabel: 'Bay',
  shelfLabel: 'Shelf',
  containers: false,        // tubs/buckets/bins on top of (or instead of) the grid
  containerLabel: 'Bucket', // what a container is called in this store
}

// One-line container label: "TUB-014 · Corolla fronts" (name optional).
export function formatContainer(c) {
  if (!c) return ''
  return [c.code, c.name].filter(Boolean).join(' · ')
}

// Normalise whatever is stored (may be partial / legacy) into a full config.
export function warehouseConfig(wh) {
  return { ...WAREHOUSE_DEFAULTS, ...(wh || {}) }
}

const num = v => (v == null || v === '' ? null : Number(v))

// A part's coordinates as { row, bay, shelf } (nulls where unset).
export function partCoords(part) {
  if (!part) return { row: null, bay: null, shelf: null }
  return {
    row: num(part.locRow ?? part.loc_row),
    bay: num(part.locBay ?? part.loc_bay),
    shelf: num(part.locShelf ?? part.loc_shelf),
  }
}

export function hasGridLoc(part) {
  const c = partCoords(part)
  return c.row != null || c.bay != null || c.shelf != null
}

// "Row 3 · Bay 5 · Shelf 2" using the store's custom labels. Omits unset axes.
export function formatGridLoc(part, wh) {
  const cfg = warehouseConfig(wh)
  const c = partCoords(part)
  const parts = []
  if (c.row != null) parts.push(`${cfg.rowLabel} ${c.row}`)
  if (c.bay != null) parts.push(`${cfg.bayLabel} ${c.bay}`)
  if (c.shelf != null) parts.push(`${cfg.shelfLabel} ${c.shelf}`)
  return parts.join(' · ')
}

// Compact badge form: "R3·B5·S2".
export function gridLocShort(part) {
  const c = partCoords(part)
  const parts = []
  if (c.row != null) parts.push(`R${c.row}`)
  if (c.bay != null) parts.push(`B${c.bay}`)
  if (c.shelf != null) parts.push(`S${c.shelf}`)
  return parts.join('·')
}
