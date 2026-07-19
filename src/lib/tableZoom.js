// Global table text-size ("zoom"). One setting for every data table — stored in
// localStorage and exposed as a CSS custom property `--table-zoom` on <html>, so
// each <table> can opt in with `zoom: var(--table-zoom, 1)`. Zooming the TABLE
// (not its scroll box) makes it grow past the container at larger sizes, which is
// exactly what brings the horizontal scrollbar into play.
const KEY = 'pv_table_zoom'

export const ZOOM_OPTIONS = [
  ['0.85', 'Compact'],
  ['1',    'Normal'],
  ['1.15', 'Large'],
  ['1.3',  'Larger'],
  ['1.5',  'Huge'],
]

export function getTableZoom() {
  try { return localStorage.getItem(KEY) || '1' } catch { return '1' }
}

export function applyTableZoom(v) {
  try { document.documentElement.style.setProperty('--table-zoom', v || '1') } catch { /* ignore */ }
}

export function setTableZoom(v) {
  try { localStorage.setItem(KEY, v) } catch { /* ignore */ }
  applyTableZoom(v)
}

// Force always-visible, classic (non-overlay) scrollbars on any element with the
// `pv-scroll` class. Windows 11 / Chrome default to auto-hiding overlay
// scrollbars, so a table's horizontal scrollbar can be invisible until you
// interact — defining an explicit ::-webkit-scrollbar height keeps it on screen.
export function injectTableScrollStyles() {
  try {
    if (typeof document === 'undefined' || document.getElementById('pv-scroll-style')) return
    const el = document.createElement('style')
    el.id = 'pv-scroll-style'
    el.textContent = `
      .pv-scroll { scrollbar-width: thin; scrollbar-color: #c2beb4 #efeee9; }
      .pv-scroll::-webkit-scrollbar { height: 12px; width: 12px; }
      .pv-scroll::-webkit-scrollbar-track { background: #efeee9; }
      .pv-scroll::-webkit-scrollbar-thumb { background: #c2beb4; border-radius: 6px; border: 2px solid #efeee9; }
      .pv-scroll::-webkit-scrollbar-thumb:hover { background: #a29e93; }
      .pv-scroll::-webkit-scrollbar-corner { background: #efeee9; }
    `
    document.head.appendChild(el)
  } catch { /* ignore */ }
}
