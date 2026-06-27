import { useState } from 'react'
import { C, S, fmt } from '../lib/constants'
import { sb } from '../lib/supabase'

// Same edge endpoint the rest of Settings uses.
const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

// ── CSV helpers ───────────────────────────────────────────────────────────────

// Proper quoted-CSV parser: handles embedded commas, newlines and "" escapes —
// the eBay Orders report has all three (e.g. buyer notes with commas/quotes).
function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const money = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
// eBay Orders report dates look like "26-Jun-26" (DD-Mon-YY).
const parseDate = (s) => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const mon = MONTHS[m[2].toLowerCase()]
  if (mon == null) return null
  let yr = +m[3]; if (yr < 100) yr += 2000
  return new Date(Date.UTC(yr, mon, +m[1])).toISOString()
}

// Turn the raw CSV text into normalised sale rows + a summary for the preview.
function extractSales(text) {
  const grid = parseCSV(text)
  // Find the header row (the eBay export has junk lines before it).
  const headerIdx = grid.findIndex(r => r.includes('Item Number') && r.includes('Order Number'))
  if (headerIdx === -1) throw new Error('This doesn’t look like an eBay Orders report (no "Item Number" / "Order Number" header).')
  const header = grid[headerIdx].map(h => h.trim())
  const col = (name) => header.indexOf(name)
  const idx = {
    order: col('Order Number'), item: col('Item Number'), title: col('Item Title'),
    sku: col('Custom Label'), qty: col('Quantity'), sold: col('Sold For'),
    ship: col('Postage And Handling'), date: col('Sale Date'), txn: col('Transaction ID'),
  }

  let summaryRows = 0
  const sales = []
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i]
    if (!r || r.every(c => !String(c).trim())) continue            // blank line
    const itemNumber = String(r[idx.item] ?? '').trim()
    if (!itemNumber) { summaryRows++; continue }                    // order-summary line
    sales.push({
      orderId:    String(r[idx.order] ?? '').trim(),
      lineItemId: String((idx.txn >= 0 ? r[idx.txn] : '') ?? '').trim() || itemNumber,
      itemNumber,
      title:      String(r[idx.title] ?? '').trim(),
      sku:        idx.sku >= 0 ? String(r[idx.sku] ?? '').trim() || null : null,
      quantity:   parseInt(r[idx.qty], 10) || 1,
      soldPrice:  money(r[idx.sold]),
      shipping:   idx.ship >= 0 ? money(r[idx.ship]) : 0,
      soldAt:     parseDate(r[idx.date]),
    })
  }
  return { sales, summaryRows }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EbayHistoryUpload({ storeId, canUpload }) {
  const [analyzing, setAnalyzing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)   // { fileName, sales, summaryRows, total, range, dupItems, alreadyHave, newCount }
  const [result, setResult] = useState(null)

  const reset = () => { setPreview(null); setResult(null); setError('') }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''                          // allow re-picking the same file
    if (!file) return
    reset(); setAnalyzing(true)
    try {
      const text = await file.text()
      const { sales, summaryRows } = extractSales(text)
      if (!sales.length) throw new Error('No sale rows found in this file.')

      // A sale line's identity is (order + item number). Repeated item numbers ACROSS
      // different orders are legitimate (multi-quantity / multi-buyer listings), so we
      // only flag a true (order, item) collision within the file.
      const key = (s) => `${s.orderId || s.itemNumber}|${s.itemNumber}`
      const counts = new Map()
      sales.forEach(s => counts.set(key(s), (counts.get(key(s)) || 0) + 1))
      const dupItems = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k.split('|')[1])

      // Which (order, item) sales do we already hold? (existing records win)
      const itemNumbers = [...new Set(sales.map(s => s.itemNumber))]
      const have = new Set()
      for (let i = 0; i < itemNumbers.length; i += 300) {
        const slice = itemNumbers.slice(i, i + 300)
        const { data, error: qErr } = await sb.from('ebay_sales')
          .select('order_id, legacy_item_id').eq('store_id', storeId).in('legacy_item_id', slice)
        if (qErr) throw new Error(qErr.message)
        ;(data ?? []).forEach(d => d.legacy_item_id && have.add(`${d.order_id}|${d.legacy_item_id}`))
      }

      const dates = sales.map(s => s.soldAt).filter(Boolean).sort()
      const newCount = sales.filter(s => !have.has(key(s))).length
      setPreview({
        fileName: file.name,
        sales, summaryRows,
        total: sales.reduce((a, s) => a + s.soldPrice, 0),
        range: dates.length ? [dates[0], dates[dates.length - 1]] : null,
        dupItems,
        alreadyHave: sales.length - newCount,
        newCount,
      })
    } catch (err) {
      setError(err.message || 'Could not read file')
    } finally {
      setAnalyzing(false)
    }
  }

  const runImport = async () => {
    if (!preview) return
    setImporting(true); setError(''); setResult(null)
    const agg = { inserted: 0, linked: 0, skippedExisting: 0, skippedNoItem: 0 }
    try {
      const rows = preview.sales
      for (let i = 0; i < rows.length; i += 300) {
        const batch = rows.slice(i, i + 300)
        const res = await fetch(EDGE_FN, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'import_orders_csv', storeId, rows: batch }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.error) throw new Error(d.error || d.message || `HTTP ${res.status}`)
        agg.inserted += d.inserted || 0
        agg.linked += d.linked || 0
        agg.skippedExisting += d.skippedExisting || 0
        agg.skippedNoItem += d.skippedNoItem || 0
      }
      setResult(agg); setPreview(null)
    } catch (err) {
      setError(err.message || 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>📜 Import sales history (CSV)</div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
        eBay’s API only reaches back ~90 days. Upload the Seller Hub <strong>Orders report</strong> to backfill older sales.
        Each sale is matched by eBay item number — anything already in PartVault is left untouched.
        Historical rows have no fees (the report doesn’t include them), so old margins will read high.
      </div>

      {!canUpload ? (
        <div style={{ fontSize: 12, color: C.yellow, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px' }}>
          ⏳ Run a full <strong>Sync now</strong> first. That pulls everything the API can reach (last ~90 days); the upload then fills the older gap without overlap.
        </div>
      ) : (
        <>
          {!preview && (
            <label style={{ ...S.btn('secondary'), display: 'inline-block', cursor: analyzing ? 'wait' : 'pointer', opacity: analyzing ? 0.6 : 1 }}>
              {analyzing ? '⏳ Analyzing…' : '📁 Choose Orders report CSV'}
              <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={analyzing} style={{ display: 'none' }} />
            </label>
          )}

          {preview && (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', background: '#f9f8f5' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Preview · {preview.fileName}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px 16px', fontSize: 12, color: C.text }}>
                <span><strong>{preview.sales.length}</strong> sale rows {preview.summaryRows ? `(+${preview.summaryRows} summary skipped)` : ''}</span>
                <span><strong>{fmt(preview.total)}</strong> total sales in file</span>
                <span>Date range: <strong>{preview.range ? `${fmtDate(preview.range[0])} → ${fmtDate(preview.range[1])}` : '—'}</strong></span>
                <span style={{ color: C.green }}><strong>{preview.newCount}</strong> new to import</span>
                <span style={{ color: C.muted }}>{preview.alreadyHave} already in PartVault (skipped)</span>
                {preview.dupItems.length > 0
                  ? <span style={{ color: C.red }}>⚠ {preview.dupItems.length} duplicate sale line(s) in file</span>
                  : <span style={{ color: C.muted }}>No duplicate sale lines ✓</span>}
              </div>
              {preview.dupItems.length > 0 && (
                <div style={{ fontSize: 11, color: C.red, marginTop: 8 }}>
                  Same order + item number appears more than once — usually a bad export. The import de-duplicates safely either way. Item(s): {preview.dupItems.slice(0, 5).join(', ')}{preview.dupItems.length > 5 ? '…' : ''}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button style={{ ...S.btn('primary'), opacity: (importing || preview.newCount === 0) ? 0.6 : 1 }} onClick={runImport} disabled={importing || preview.newCount === 0}>
                  {importing ? '⏳ Importing…' : `Import ${preview.newCount} new sales`}
                </button>
                <button style={S.btn('secondary')} onClick={reset} disabled={importing}>Cancel</button>
              </div>
            </div>
          )}

          {result && (
            <div style={{ fontSize: 12, color: C.green, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '8px 12px', marginTop: 10 }}>
              ✓ Imported <strong>{result.inserted}</strong> historical sales
              {result.linked ? ` · ${result.linked} linked to a part` : ''}
              {result.skippedExisting ? ` · ${result.skippedExisting} already had records` : ''}.
              <span style={{ color: C.muted }}> Switch the Dashboard period to “All” to see them.</span>
            </div>
          )}
        </>
      )}

      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>✗ {error}</div>}
    </div>
  )
}
