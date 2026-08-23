import { useState, useRef, useEffect } from 'react'
import { C, S, CATEGORY_NAMES, STATUS_COLORS, STATUS_LABELS } from '../lib/constants'
import { sb, FN_URL } from '../lib/supabase'
import { getActiveMarketplace } from '../lib/marketplaces'
import { makesFor, MODEL_SUGS } from '../lib/vehicles'


// Shared building blocks of the Inventory suite — extracted verbatim from
// Inventory.jsx (refactor 3/5). Small display components, the inline-editable
// table cell, cost tiers, photo helpers and the Add-Car modal live here;
// PartForm.jsx and Inventory.jsx compose them.
function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><label style={S.label}>{label}</label>{children}</div>
}

// Direct link to a part's live listing on the store's eBay marketplace.
export const ebayItmUrl = (itemId) => `https://www.${getActiveMarketplace()?.ebayDomain || 'ebay.com.au'}/itm/${itemId}`

// Compact eBay wordmark (the four brand colours) — used as a small icon, no image.
function EbayLogo() {
  return (
    <span style={{ fontWeight:800, fontSize:11, fontFamily:'Arial,Helvetica,sans-serif', letterSpacing:'-0.4px', lineHeight:1 }}>
      <span style={{ color:'#e53238' }}>e</span><span style={{ color:'#0064d2' }}>b</span><span style={{ color:'#f5af02' }}>a</span><span style={{ color:'#86b817' }}>y</span>
    </span>
  )
}
// Small eBay-logo link button (icon only) — opens the live listing in a new tab.
// Sample parts carry a fake SAMPLE-… item id, so there's no real listing to open.
function EbayLink({ part, style }) {
  if (!(part.status === 'listed' && part.ebayItemId) || part.isSample) return null
  return (
    <a href={ebayItmUrl(part.ebayItemId)} target="_blank" rel="noreferrer" title="View this listing on eBay"
       style={{ display:'inline-flex', alignItems:'center', textDecoration:'none', cursor:'pointer', ...style }}>
      <EbayLogo />
    </a>
  )
}

// Status pill. The click-through to eBay lives on the dedicated eBay icon in the
// action column, so this stays a plain pill (keeps the busy list uncluttered).
function StatusPill({ part, fontSize = 11, padding }) {
  const col = STATUS_COLORS[part.status] || C.muted
  const label = STATUS_LABELS[part.status] || part.status
  return <span style={{ ...S.pill(col), fontSize, ...(padding ? { padding } : {}) }}>{label}</span>
}

// eBay-style accent + section card (mirrors eBay's "Create your listing" layout)
const EBAY_BLUE = '#3665f3'

// Spreadsheet-style cell for the By-Part table: click to edit in place (no need
// to open the part form). Enter or click-away saves; Esc cancels. `display`
// overrides how the value renders when not editing (e.g. "$120", a status pill).
function EditableTd({ value, display, type = 'text', options, align, color, bold, onSave, title }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value ?? '')
  const skip = useRef(false)
  useEffect(() => { if (!editing) setV(value ?? '') }, [value, editing])
  const baseStyle = { padding: '4px 8px', fontSize: 12, color: color || C.text, fontWeight: bold ? 700 : 400, textAlign: align || 'left', borderBottom: `1px solid ${C.border}`, borderRight: `1px solid ${C.border}`, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }
  if (!editing) {
    return (
      <td style={{ ...baseStyle, cursor: 'text' }} title={`${title ?? value ?? ''}${title ?? value ? ' — ' : ''}click to edit`}
        onClick={() => { skip.current = false; setV(value ?? ''); setEditing(true) }}>
        {display ?? (value || <span style={{ color: C.border }}>—</span>)}
      </td>
    )
  }
  const done = (val) => {
    setEditing(false)
    if (skip.current) { skip.current = false; return }
    if (String(val ?? '') !== String(value ?? '')) onSave(val)
  }
  const keys = (e) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') { skip.current = true; e.currentTarget.blur() }
  }
  const inStyle = { width: '100%', fontSize: 12, padding: '2px 4px', border: `1.5px solid ${C.accent}`, borderRadius: 4, boxSizing: 'border-box', textAlign: align || 'left', background: '#fff' }
  return (
    <td style={{ ...baseStyle, padding: '2px 4px' }}>
      {type === 'select' ? (
        <select autoFocus value={v} onChange={e => setV(e.target.value)} onBlur={e => done(e.target.value)} onKeyDown={keys} style={inStyle}>
          {(options || []).map(([ov, ol]) => <option key={ov} value={ov}>{ol}</option>)}
        </select>
      ) : (
        <input autoFocus type={type} value={v} onChange={e => setV(e.target.value)} onBlur={e => done(e.target.value)} onKeyDown={keys} style={inStyle} />
      )}
    </td>
  )
}

// By-Part table columns [label, width, align]. Locked via table-layout:fixed so
// the grid is IDENTICAL across By-Part / List / De-list — switching modes changes
// the row contents, never the column positions. Money columns are right-aligned
// so they line up by place value (and under the TOTALS footer).
const BYPART_COLS = [
  ['Edit', 172, 'left'], ['SKU', 92, 'left'], ['Title', 260, 'left'],
  ['Make', 90, 'left'], ['Model', 100, 'left'], ['Year', 68, 'left'],
  ['Category', 150, 'left'], ['Status', 92, 'left'], ['AI', 44, 'center'],
  ['List$', 80, 'right'], ['Cost', 80, 'right'], ['Profit', 86, 'right'], ['Del', 54, 'center'],
]
const BYPART_MINW = BYPART_COLS.reduce((n, c) => n + c[1], 0)
function Section({ title, hint, action, children, accent }) {
  return (
    <div style={{ background:'#fff', border:`1px solid ${C.border}`, borderRadius:14, padding:'18px 22px', marginBottom:16, boxShadow:'0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, gap:12 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0 }}>
          <span style={{ width:4, height:18, borderRadius:2, background:accent||EBAY_BLUE, flexShrink:0 }} />
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:16, fontWeight:700, color:C.text, fontFamily:"'Inter Tight',system-ui,sans-serif" }}>{title}</div>
            {hint && <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{hint}</div>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function AutoInput({ value, onChange, suggestions, placeholder, style }) {
  const [open, setOpen] = useState(false)
  const filtered = (suggestions || []).filter(s => s.toLowerCase().includes((value||'').toLowerCase())).slice(0, 8)
  return (
    <div style={{ position: 'relative' }}>
      <input style={style || S.input} value={value || ''} onChange={e => { onChange(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder={placeholder} autoComplete="off" />
      {open && filtered.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: `1.5px solid ${C.accent}`, borderRadius: 8, zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.12)', maxHeight: 200, overflowY: 'auto', marginTop: 2 }}>
          {filtered.map(s => (
            <div key={s} onMouseDown={() => { onChange(s); setOpen(false) }} style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer', borderBottom: `1px solid ${C.border}`, color: C.text }}
              onMouseEnter={e => e.currentTarget.style.background = '#fff4ef'} onMouseLeave={e => e.currentTarget.style.background = '#fff'}>{s}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// Shared prompt body (no "return only text" / JSON instruction — the caller adds that).
function descPromptCore(part, aiSettings) {
  const lengthGuide = { short: '2-3 sentences covering key facts', medium: '1-2 paragraphs with good detail', long: 'comprehensive description with full fitment and condition detail' }[aiSettings?.descriptionLength || 'medium']
  const fields = []
  if (aiSettings?.includeMake) fields.push('make')
  if (aiSettings?.includeModel) fields.push('model')
  if (aiSettings?.includeSeries) fields.push('series/badge variant')
  if (aiSettings?.includeYearRange) fields.push('year range compatibility (CRITICAL: research beyond just the donor car year)')
  if (aiSettings?.includePartNumber) fields.push('OEM part number')
  if (aiSettings?.includeConditionDetail) fields.push('condition detail')
  if (aiSettings?.includeInstallLink && aiSettings?.installLinkUrl) fields.push(`install guide: ${aiSettings.installLinkUrl} with mechanic disclaimer`)
  const mkLabel = { EBAY_AU: 'Australian', EBAY_US: 'US', EBAY_GB: 'UK', EBAY_CA: 'Canadian' }[getActiveMarketplace().id] || 'Australian'
  return `You are writing an eBay listing description for a used auto part sold on the ${mkLabel} eBay marketplace.\nPart: ${part.title||'Unknown'}\nMake: ${part.make||''} Model: ${part.model||''} Year: ${part.year||''}\nCategory: ${part.category||''} > ${part.subcategory||''}\nCondition: ${part.condition||'Used – Good'}\nOEM Part#: ${part.partNumber||'Not specified'}\nNotes: ${part.notes||'None'}\nWrite a ${lengthGuide}. Include: ${fields.join(', ')}.\n${aiSettings?.customPromptNotes||''}\nDo NOT include a store footer. Plain text only.`
}

async function callDescribe(body) {
  const { data: { session } } = await sb.auth.getSession()
  const resp = await fetch(FN_URL('ai-assess'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ mode: 'describe', ...body }),
  })
  const data = await resp.json()
  if (!resp.ok || data.error) throw new Error(data.error || 'AI description failed')
  return data
}

// Learning context so ai-assess can prefer this store's own recent examples.
const learnCtx = (part) => ({ make: part.make || '', category: part.category || '', partId: part.id || undefined })

async function generateAIDescription(part, aiSettings, footer, storeId) {
  const data = await callDescribe({ storeId, ...learnCtx(part), prompt: `${descPromptCore(part, aiSettings)} Return ONLY the description text.` })
  return (data.text || '').trim()
}

// Several ranked description options for the seller to choose from.
async function generateDescriptionOptions(part, aiSettings, storeId, count = 5) {
  const data = await callDescribe({ storeId, ...learnCtx(part), prompt: descPromptCore(part, aiSettings), options: count })
  return Array.isArray(data.descriptions) ? data.descriptions : []
}

// "Write my own → regenerate": 4 improved variants of the seller's own text.
async function regenerateDescriptionOptions(userText, part, aiSettings, storeId) {
  const prompt = `${descPromptCore(part, aiSettings)}\n\nThe seller wrote this description:\n"${userText}"\nWrite 4 improved variants based on it — keep the same meaning/intent, improve wording and detail, ranked best first.`
  const data = await callDescribe({ storeId, ...learnCtx(part), prompt, options: 4 })
  return Array.isArray(data.descriptions) ? data.descriptions : []
}

// Extract a usable URL from a stored photo value (string, JSON string, or object).
function urlFrom(v) {
  if (!v) return null
  if (typeof v === 'object') return v.url || v.ebay_url || null
  try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v }
}
// AI assessment is photo-based — a part with no photo can't be auto-assessed.
const partHasPhoto = (p) => (p.photos || []).some(v => !!urlFrom(v))

// Calls the ai-assess edge function (holds the platform Anthropic key as a
// secret — no key in the browser). Pass all the part's photos so the AI can
// assess across every angle / label / part-number close-up.
async function analysePart({ photoBase64s, photoUrls, carId, partId }, car, storeId) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(FN_URL('ai-assess'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    // partId (optional) makes the server PERSIST the full assessment via service
    // role — used by the background queue so results are saved without the editor
    // being open. Interactive callers omit it (they apply to the form for review).
    body: JSON.stringify({ storeId, photoBase64s, photoUrls, car, carId, partId, categories: CATEGORY_NAMES }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'AI assessment failed')
  // Surface a learned price (from your own history) so the form can prefer it.
  return { ...data.result, _learnedPrice: data.learnedPrice || 0, _learnedFrom: data.learnedFrom || '' }
}

function compressImg(file, callback) {
  const img = new window.Image(); const url = URL.createObjectURL(file)
  img.onload = () => { const c = document.createElement('canvas'); const r = Math.min(1200/img.width, 1200/img.height, 1); c.width=img.width*r; c.height=img.height*r; c.getContext('2d').drawImage(img,0,0,c.width,c.height); callback(c.toDataURL('image/jpeg',0.82)); URL.revokeObjectURL(url) }
  img.src = url
}

async function uploadPhoto(base64DataUrl, storeId) {
  const base64 = base64DataUrl.split(',')[1]
  const mime = base64DataUrl.split(';')[0].split(':')[1]
  const bs = atob(base64); const ab = new ArrayBuffer(bs.length); const ia = new Uint8Array(ab)
  for (let i = 0; i < bs.length; i++) ia[i] = bs.charCodeAt(i)
  const blob = new Blob([ab], { type: mime })
  const path = `car-photos/${storeId}/${crypto.randomUUID()}.jpg`
  const { error } = await sb.storage.from('part-photos').upload(path, blob, { upsert: true, contentType: mime })
  if (error) throw error
  const { data: { publicUrl } } = sb.storage.from('part-photos').getPublicUrl(path)
  return publicUrl
}

const defCosts = () => ({ acquisition: 0, labour: 15, storage: 1.5, packaging: 8, postage: 18, holding: 0 })
const COST_TIERS = { small:{acquisition:0,labour:5,storage:0.5,packaging:3,postage:12,holding:0}, medium:{acquisition:0,labour:15,storage:1.5,packaging:8,postage:18,holding:0}, large:{acquisition:0,labour:35,storage:4,packaging:20,postage:55,holding:0}, bulky:{acquisition:0,labour:60,storage:6,packaging:0,postage:0,holding:0} }

// ─── Add Car Modal ─────────────────────────────────────────────────────────
function AddCarModal({ storeId, onSave, onCancel }) {
  const [form, setForm] = useState({ make: '', model: '', year: '', purchase_price: '', purchase_date: new Date().toISOString().split('T')[0], notes: '' })
  const [photos, setPhotos] = useState([])
  const [saving, setSaving] = useState(false)
  const photoRef = useRef()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const handlePhoto = e => { Array.from(e.target.files||[]).slice(0, 6-photos.length).forEach(f => compressImg(f, d => setPhotos(p => [...p, d]))); e.target.value='' }

  const handleSave = async () => {
    if (!form.make) return
    setSaving(true)
    try {
      const { data: { user } } = await sb.auth.getUser()
      let photoUrls = []
      for (const p of photos) { try { photoUrls.push(await uploadPhoto(p, storeId)) } catch(e) { console.warn('Photo upload failed', e) } }
      const { data, error } = await sb.from('cars').insert({ store_id: storeId, created_by: user?.id, make: form.make, model: form.model, year: form.year, purchase_price: form.purchase_price ? +form.purchase_price : null, purchase_date: form.purchase_date||null, notes: form.notes, status: 'active', photos: photoUrls }).select().single()
      if (error) throw error
      // Dual-write: also insert into the new photos table (column above kept during transition)
      if (photoUrls.length) {
        const { error: photoErr } = await sb.from('photos').insert(
          photoUrls.map((url, i) => ({
            parent_type: 'car', parent_id: data.id, url,
            display_order: i, is_primary: i === 0, source: 'upload',
          }))
        )
        if (photoErr) console.warn('photos table insert failed', photoErr)
      }
      onSave(data)
    } catch(e) { console.error('Add car failed', e) }
    setSaving(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ ...S.card, maxWidth: 560, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={S.h1}>🚗 Add Car</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={S.btn('secondary')} onClick={onCancel}>Cancel</button>
            <button style={S.btn()} onClick={handleSave} disabled={saving || !form.make}>{saving ? 'Saving...' : 'Add Car'}</button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Make *">
            <select style={S.select} value={form.make} onChange={e => { set('make', e.target.value); set('model', '') }}>
              <option value="">Select Make</option>
              {makesFor().map(m => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <AutoInput value={form.model} onChange={v => set('model', v)} suggestions={MODEL_SUGS[form.make]||[]} placeholder="Model" />
          </Field>
        </div>
        <Field label="Year"><input style={S.input} value={form.year} onChange={e => set('year', e.target.value)} placeholder="e.g. 2018" /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Purchase Price ($)"><input style={S.input} type="number" value={form.purchase_price} onChange={e => set('purchase_price', e.target.value)} /></Field>
          <Field label="Purchase Date"><input style={S.input} type="date" value={form.purchase_date} onChange={e => set('purchase_date', e.target.value)} /></Field>
        </div>
        <Field label="Notes"><textarea style={{ ...S.textarea, minHeight: 60 }} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Condition, source, notes..." /></Field>
        <div style={{ marginBottom: 8 }}>
          <label style={S.label}>Car Photos <span style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>(attached to all parts)</span></label>
          <input ref={photoRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handlePhoto} />
          {photos.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {photos.map((p, i) => (
                <div key={i} style={{ position: 'relative', width: 72, height: 72 }}>
                  <img src={p} style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover' }} />
                  {i === 0 && <div style={{ position: 'absolute', top: 3, left: 3, background: C.accent, borderRadius: 4, padding: '1px 5px', fontSize: 8, color: '#fff', fontWeight: 800 }}>COVER</div>}
                  <button onClick={() => setPhotos(ps => ps.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -6, right: -6, background: C.red, border: 'none', color: '#fff', borderRadius: '50%', width: 20, height: 20, fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: '20px', padding: 0 }}>×</button>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => photoRef.current.click()} style={{ ...S.btn('secondary'), display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px' }}>
            📷 {photos.length === 0 ? 'Add Photos' : `Add More (${photos.length}/6)`}
          </button>
        </div>
      </div>
    </div>
  )
}

// Weight input: grams stored always; US stores enter/see lb + oz (converted).
function WeightField({ grams, onChange }) {
  if (getActiveMarketplace().weightUnit !== 'oz') {
    return <input style={S.input} type="number" value={grams || ''} onChange={e => onChange(e.target.value)} />
  }
  const totalOz = (+grams || 0) / 28.3495
  const lb = Math.floor(totalOz / 16)
  const oz = +(totalOz % 16).toFixed(1)
  const setLbOz = (nlb, noz) => onChange(Math.round(((+nlb || 0) * 16 + (+noz || 0)) * 28.3495))
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input style={S.input} type="number" placeholder="lb" value={grams ? lb : ''} onChange={e => setLbOz(e.target.value, oz)} />
      <input style={S.input} type="number" placeholder="oz" value={grams ? oz : ''} onChange={e => setLbOz(lb, e.target.value)} />
    </div>
  )
}

// ─── Part Form ─────────────────────────────────────────────────────────────

// ─── Phone layouts ─────────────────────────────────────────────────────────

// One part as a card, for phone-width screens where the 13-column By-Part grid
// can't fit. Same data, same actions, stacked: identity → classification →
// money → actions. Used by BOTH the By-Part list and the expanded By-Car list,
// so a part looks the same wherever it appears.
function PartCard({ part: p, cost = 0, selectable = false, selected = false, onToggleSel, onEdit, onPreview, onPrintLabel, onDelete }) {
  const lp = +p.list_price || 0
  const profit = lp - cost
  const qtyLeft = Math.max(0, (+p.quantity || 0) - (+p.quantitySold || 0))
  // 44pt in both directions — a phone tap target, not a desktop icon button.
  const iconBtn = { width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: 0 }
  const money = (label, value, col, bold) => (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: bold ? 800 : 700, color: col }}>{value}</div>
    </div>
  )
  return (
    <div style={{ background: selected ? '#eef2ff' : (p.deletedAt ? '#fff5f5' : C.card), border: `1px solid ${selected ? C.blue : C.border}`, borderRadius: 12, padding: 12, marginBottom: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {selectable && (
          <input type="checkbox" checked={selected} onChange={() => onToggleSel?.(p.id)} aria-label="Select this part"
            style={{ width: 22, height: 22, marginTop: 2, flexShrink: 0, cursor: 'pointer' }} />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, lineHeight: 1.3, wordBreak: 'break-word' }}>
            {p.isSample ? '🧪 ' : ''}{p.title || 'Untitled'}
            {+p.quantity > 1 && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: C.accent, background: C.accentSoft, border: `1px solid ${C.border}`, borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap' }}>×{qtyLeft}</span>}
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 3 }}>
            {p.sku || 'no SKU'}{p.partNumber ? ` · #${p.partNumber}` : ''}
            {[p.make, p.model, p.year].filter(Boolean).length ? ` · ${[p.make, p.model, p.year].filter(Boolean).join(' ')}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 7 }}>
            <StatusPill part={p} />
            <span style={{ fontSize: 13, color: C.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.subcategory || p.category || '—'}</span>
            <span style={{ fontSize: 13 }} title={!partHasPhoto(p) ? 'Add a photo — AI assessment needs one' : (p.ai_assessed ? 'AI assessed' : 'Needs AI')}>
              {!partHasPhoto(p) ? '📷' : (p.ai_assessed ? '✅' : '⬜')}
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, margin: '10px 0', padding: '8px 0', borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        {money('List', lp > 0 ? `$${lp.toFixed(0)}` : '—', C.text, true)}
        {money('Cost', `$${cost.toFixed(0)}`, C.red)}
        {money('Profit', `$${profit.toFixed(0)}`, profit >= 0 ? C.green : C.red)}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => onEdit?.(p)} style={{ ...S.btn('secondary'), flex: 1, height: 44, fontSize: 14, padding: '0 12px' }}>Edit</button>
        <button onClick={() => onPreview?.(p)} title="Preview the eBay listing" style={iconBtn}>👁</button>
        {p.sku && <button onClick={() => onPrintLabel?.(p)} title="Print stock label" style={iconBtn}>🏷️</button>}
        <EbayLink part={p} style={{ ...iconBtn, width: 44 }} />
        <button onClick={() => onDelete?.(p)} title="Delete this part" style={{ ...iconBtn, background: '#fef2f2', borderColor: `${C.red}44`, color: C.red }}>🗑</button>
      </div>
    </div>
  )
}

export { PartCard, Field, EbayLogo, EbayLink, StatusPill, EBAY_BLUE, EditableTd, BYPART_COLS, BYPART_MINW, Section, AutoInput, descPromptCore, learnCtx, urlFrom, partHasPhoto, compressImg, defCosts, COST_TIERS, AddCarModal, WeightField, generateAIDescription, generateDescriptionOptions, regenerateDescriptionOptions, analysePart }
