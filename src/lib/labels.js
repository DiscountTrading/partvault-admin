import QRCode from 'qrcode'

// Stock labels — printable SKU + scannable QR stickers for the shelf. Size and
// contents are configurable (stores.settings.labels) so any printer works: a
// thermal label roll ('roll' = one label per page, sized in mm) or an A4 sheet
// of labels ('sheet' = grid). The QR encodes a deep link the PWA can resolve to
// open the part (scan-to-find in the yard).
export const DEFAULT_LABELS = {
  widthMm: 50, heightMm: 30, mode: 'roll', sheetCols: 3,
  showQR: true, showSku: true, showTitle: true, showFitment: true, showPrice: false,
  qrBaseUrl: 'https://app.partvault.app',
  // Mobile capture flow: when finishing a part, prompt to print a stock label.
  // 'ask' (prompt each time, with "don't ask again") · 'always' · 'never'.
  onDone: 'ask',
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const labelTarget = (p, cfg) => `${(cfg.qrBaseUrl || '').replace(/\/$/, '')}/p/${encodeURIComponent(p.sku || p.id)}`

// Generate the label(s) and open a print window. `parts` may be one part or many.
export async function printLabels(parts, cfg = DEFAULT_LABELS) {
  const c = { ...DEFAULT_LABELS, ...(cfg || {}) }
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean)
  if (!list.length) return

  const qr = {}
  if (c.showQR) {
    await Promise.all(list.map(async p => {
      try { qr[p.id] = await QRCode.toDataURL(labelTarget(p, c), { margin: 0, scale: 6 }) } catch { qr[p.id] = '' }
    }))
  }

  const W = +c.widthMm || 50, H = +c.heightMm || 30
  const qrMm = Math.max(8, Math.min(H - 3, W * 0.42))
  const labelHtml = (p) => {
    const fitment = [p.make, p.model, p.year].filter(Boolean).join(' ')
    const price = +(p.listPrice ?? p.list_price ?? 0)
    const rows = []
    if (c.showSku && p.sku) rows.push(`<div class="sku">${esc(p.sku)}</div>`)
    if (c.showTitle && p.title) rows.push(`<div class="title">${esc(p.title)}</div>`)
    if (c.showFitment && fitment) rows.push(`<div class="fit">${esc(fitment)}</div>`)
    if (c.showPrice && price > 0) rows.push(`<div class="price">$${price.toFixed(0)}</div>`)
    return `<div class="label">${c.showQR && qr[p.id] ? `<img class="qr" src="${qr[p.id]}"/>` : ''}<div class="info">${rows.join('')}</div></div>`
  }

  const isSheet = c.mode === 'sheet'
  const pageCss = isSheet
    ? `@page { size: A4; margin: 8mm; } .sheet { display:grid; grid-template-columns:repeat(${+c.sheetCols || 3}, 1fr); gap:2mm; }`
    : `@page { size: ${W}mm ${H}mm; margin: 0; } body { margin:0; } .label { page-break-after: always; }`

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Stock labels</title><style>
    *{box-sizing:border-box;} body{font-family:'Inter Tight',system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    ${pageCss}
    .label{width:${W}mm;height:${H}mm;display:flex;align-items:center;gap:2mm;padding:1.5mm;overflow:hidden;${isSheet ? 'border:0.2mm solid #ccc;' : ''}}
    .qr{height:${qrMm}mm;width:${qrMm}mm;flex-shrink:0;}
    .info{flex:1;min-width:0;line-height:1.18;}
    .sku{font-weight:800;font-size:${Math.max(8, H * 0.16)}pt;letter-spacing:-0.2px;}
    .title{font-size:6.5pt;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
    .fit{font-size:6.5pt;font-weight:600;}
    .price{font-size:9pt;font-weight:800;}
  </style></head><body>
    ${isSheet ? `<div class="sheet">${list.map(labelHtml).join('')}</div>` : list.map(labelHtml).join('')}
    <script>window.onload=function(){setTimeout(function(){window.print();},150);};<\/script>
  </body></html>`

  // Open in a floating pop-up window (not a new tab) so printing a sticker doesn't
  // navigate away from the current page — matches the packing-slip behaviour.
  const w = window.open('', '_blank', 'width=520,height=640')
  if (!w) { alert('Pop-up blocked — allow pop-ups for this site to print labels.'); return }
  w.document.write(html)
  w.document.close()
}
