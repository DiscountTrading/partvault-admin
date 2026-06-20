import { useState, useMemo, useRef } from 'react'
import { C, S, fmt, pct, totalCost, estimateCostBasis, CATEGORY_NAMES, EBAY_AU_CATEGORIES, PART_CONDITIONS, STATUS_COLORS, STATUS_LABELS } from '../lib/constants'
import { sb } from '../lib/supabase'

const MAKES = ['Toyota','Ford','Holden','Mazda','Hyundai','Kia','Mitsubishi','Nissan','Subaru','Honda','Volkswagen','BMW','Mercedes-Benz','Audi','Land Rover','Isuzu','Suzuki','Lexus','Jeep','Volvo','Other']
const MODEL_SUGS = {Toyota:['Hilux','Camry','Corolla','RAV4','LandCruiser','LandCruiser 200','Prado','HiAce','Kluger','Yaris','Aurion'],Ford:['Ranger','Falcon','Territory','Focus','Fiesta','Escape','Explorer','Mustang','Transit'],Holden:['Commodore','Colorado','Trax','Captiva','Cruze','Astra','Barina','Trailblazer'],Mazda:['CX-5','CX-3','CX-9','CX-7','Mazda3','Mazda6','BT-50','MX-5','RX-7','RX-8'],Hyundai:['i30','Tucson','Santa Fe','i20','Accent','Elantra','Sonata','ix35','Kona'],Kia:['Sportage','Cerato','Rio','Sorento','Carnival','Stinger','Seltos'],Mitsubishi:['Triton','ASX','Outlander','Eclipse Cross','Pajero','Lancer'],Nissan:['Navara','X-Trail','Patrol','Pathfinder','Qashqai','Pulsar','Skyline'],Subaru:['Forester','Outback','Impreza','Liberty','WRX','BRZ','XV'],Honda:['CR-V','HR-V','Jazz','Civic','Accord'],Volkswagen:['Golf','Polo','Tiguan','Passat','Amarok'],BMW:['3 Series','5 Series','7 Series','X3','X5','X1'],'Mercedes-Benz':['C-Class','E-Class','S-Class','GLC','GLE','A-Class'],'Land Rover':['Discovery','Range Rover','Defender'],Isuzu:['D-Max','MU-X'],Suzuki:['Swift','Vitara','Jimny'],Lexus:['RX','NX','GX','IS'],Jeep:['Wrangler','Cherokee','Grand Cherokee'],Volvo:['XC90','XC60','XC40']}

function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><label style={S.label}>{label}</label>{children}</div>
}

// eBay-style accent + section card (mirrors eBay's "Create your listing" layout)
const EBAY_BLUE = '#3665f3'
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

async function generateAIDescription(part, aiSettings, footer, storeId) {
  const lengthGuide = { short: '2-3 sentences covering key facts', medium: '1-2 paragraphs with good detail', long: 'comprehensive description with full fitment and condition detail' }[aiSettings?.descriptionLength || 'medium']
  const fields = []
  if (aiSettings?.includeMake) fields.push('make')
  if (aiSettings?.includeModel) fields.push('model')
  if (aiSettings?.includeSeries) fields.push('series/badge variant')
  if (aiSettings?.includeYearRange) fields.push('year range compatibility (CRITICAL: research beyond just the donor car year)')
  if (aiSettings?.includePartNumber) fields.push('OEM part number')
  if (aiSettings?.includeConditionDetail) fields.push('condition detail')
  if (aiSettings?.includeInstallLink && aiSettings?.installLinkUrl) fields.push(`install guide: ${aiSettings.installLinkUrl} with mechanic disclaimer`)
  const prompt = `You are writing an eBay listing description for a used Australian auto part.\nPart: ${part.title||'Unknown'}\nMake: ${part.make||''} Model: ${part.model||''} Year: ${part.year||''}\nCategory: ${part.category||''} > ${part.subcategory||''}\nCondition: ${part.condition||'Used – Good'}\nOEM Part#: ${part.partNumber||'Not specified'}\nNotes: ${part.notes||'None'}\nWrite a ${lengthGuide}. Include: ${fields.join(', ')}.\n${aiSettings?.customPromptNotes||''}\nDo NOT include a store footer. Plain text only. Return ONLY the description text.`
  const { data: { session } } = await sb.auth.getSession()
  const resp = await fetch('https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ storeId, mode: 'describe', prompt }),
  })
  const data = await resp.json()
  if (!resp.ok || data.error) throw new Error(data.error || 'AI description failed')
  return (data.text || '').trim()
}

// Extract a usable URL from a stored photo value (string, JSON string, or object).
function urlFrom(v) {
  if (!v) return null
  if (typeof v === 'object') return v.url || v.ebay_url || null
  try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v }
}

// Calls the ai-assess edge function (holds the platform Anthropic key as a
// secret — no key in the browser). Pass all the part's photos so the AI can
// assess across every angle / label / part-number close-up.
async function analysePart({ photoBase64s, photoUrls, carId }, car, storeId) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch('https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ storeId, photoBase64s, photoUrls, car, carId, categories: CATEGORY_NAMES }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'AI assessment failed')
  return data.result
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
              {MAKES.map(m => <option key={m}>{m}</option>)}
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
          <label style={S.label}>Car Photos <span style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>(attached to all parts — uploaded to Supabase Storage)</span></label>
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

// ─── Part Form ─────────────────────────────────────────────────────────────
function PartForm({ part, cars, storeId, onSave, onSaveAndAdd, onCancel, aiSettings, footer, costing, allParts = [] }) {
  const defCat = CATEGORY_NAMES[4]
  const [form, setForm] = useState(part ? { ...part, costs: { ...part.costs }, listPrice: part.list_price||part.listPrice||0, ai_assessed: part.ai_assessed??false, acquiredDate: part.acquiredDate ? String(part.acquiredDate).slice(0,10) : (part.createdAt ? String(part.createdAt).slice(0,10) : '') } : {
    title:'', category:defCat, subcategory:EBAY_AU_CATEGORIES[defCat][0], make:'', model:'', year:'', condition:PART_CONDITIONS[1],
    description:'', acquiredDate:new Date().toISOString().slice(0,10), costs:defCosts(), listPrice:'', soldPrice:'', photos:[], weight:'', status:'in_stock',
    partNumber:'', notes:'', ai_assessed:false, car_id:null,
  })
  const [generating, setGenerating] = useState(false)
  const [analysing, setAnalysing] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiPhotos, setAiPhotos] = useState([])
  const [uncheckedWarning, setUncheckedWarning] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewErr, setPreviewErr] = useState('')
  const [specEdits, setSpecEdits] = useState({})       // name -> current (possibly edited) value
  const [specBaseline, setSpecBaseline] = useState({}) // name -> value as computed/loaded
  const [fitEdits, setFitEdits] = useState([])         // editable compatible-vehicle rows
  const [fitBaseline, setFitBaseline] = useState('[]')
  const [savingSpecs, setSavingSpecs] = useState(false)
  const [specsSaved, setSpecsSaved] = useState(false)
  const [previewSig, setPreviewSig] = useState('') // inputs the loaded preview was built from
  const photoRef = useRef()

  // Read-only preview of the exact eBay category + item specifics + fitment that
  // a publish would send, generated from the part's photos (one AI call).
  const loadPreview = async () => {
    if (!part?.id) return
    setPreviewLoading(true); setPreviewErr('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'preview_listing', storeId, partId: part.id, title: form.title, price: +form.listPrice || 0, condition: form.condition, description: form.description || '' }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Preview failed')
      setPreview(d)
      const base = {}; (d.specifics || []).forEach(s => { base[s.name] = s.value || '' })
      setSpecBaseline(base); setSpecEdits(base)
      const fit = (d.fitment || []).map(f => ({ make:f.make||'', model:f.model||'', yearFrom:f.yearFrom||'', yearTo:f.yearTo||'', trim:f.trim||'' }))
      setFitEdits(fit); setFitBaseline(JSON.stringify(fit))
      setPreviewSig(previewInputSig())
    } catch (e) { setPreviewErr(e.message) }
    setPreviewLoading(false)
  }
  // Signature of the inputs that affect the preview — so we only rebuild (an AI
  // call) when something actually changed.
  const previewInputSig = () => JSON.stringify({ t: form.title, p: +form.listPrice || 0, c: form.condition, d: form.description || '', ov: form.ebayOverrides || null })
  const togglePreview = () => {
    const next = !previewOpen
    setPreviewOpen(next)
    if (next && !previewLoading && (!preview || previewSig !== previewInputSig())) loadPreview()
  }
  const setSpec = (name, val) => setSpecEdits(e => ({ ...e, [name]: val }))
  const setFit = (i, k, val) => setFitEdits(rows => rows.map((r, j) => j === i ? { ...r, [k]: val } : r))
  const addFit = () => setFitEdits(rows => [...rows, { make:'', model:'', yearFrom:'', yearTo:'', trim:'' }])
  const removeFit = (i) => setFitEdits(rows => rows.filter((_, j) => j !== i))
  const specDirty = Object.keys(specEdits).some(n => (specEdits[n] || '') !== (specBaseline[n] || ''))
  const fitDirty = JSON.stringify(fitEdits) !== fitBaseline
  const ovDirty = specDirty || fitDirty
  // Persist the user's corrections as per-part overrides (they win at publish).
  const saveSpecs = async () => {
    if (!part?.id) return
    setSavingSpecs(true); setPreviewErr('')
    try {
      const changed = {}
      Object.keys(specEdits).forEach(n => { if ((specEdits[n] || '') !== (specBaseline[n] || '')) changed[n] = specEdits[n] })
      const merged = { ...(form.ebayOverrides?.specifics || {}), ...changed }
      const newOv = { ...(form.ebayOverrides || {}), specifics: merged }
      if (fitDirty) {
        newOv.fitment = fitEdits
          .filter(r => r.make && r.model)
          .map(r => ({ make:r.make, model:r.model, yearFrom:+r.yearFrom||undefined, yearTo:+r.yearTo||+r.yearFrom||undefined, trim:r.trim||'' }))
      }
      const { error } = await sb.from('parts').update({ ebay_overrides: newOv }).eq('id', part.id)
      if (error) throw error
      setForm(f => ({ ...f, ebayOverrides: newOv }))
      setSpecBaseline({ ...specEdits }); setFitBaseline(JSON.stringify(fitEdits))
      setSpecsSaved(true); setTimeout(() => setSpecsSaved(false), 2000)
    } catch (e) { setPreviewErr(e.message) }
    setSavingSpecs(false)
  }
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setCost = (k, v) => setForm(f => ({ ...f, costs: { ...f.costs, [k]: +v||0 } }))
  const manualCost = Object.values(form.costs||{}).reduce((a,v) => a+(+v||0), 0)
  // Estimated cost basis from the store costing config (car-cost share + removal
  // labour + admin). carPartsValue = sum of list prices of this car's parts.
  const formCar = cars?.find(c => c.id === form.car_id)
  const carPartsValue = (allParts||[]).filter(p => p.car_id === form.car_id && !p.deletedAt)
    .reduce((a,p) => a + (p.id === form.id ? (+form.listPrice||0) : (+p.list_price||+p.listPrice||0)), 0)
  const basis = estimateCostBasis({ list_price: +form.listPrice||0, removalMinutes: form.removalMinutes }, costing, +formCar?.purchase_price||0, carPartsValue)
  const cost = manualCost + basis.total
  const profit = (+form.listPrice||0) - cost
  const margin = +form.listPrice > 0 ? (profit / +form.listPrice) * 100 : 0

  const handlePhoto = e => { Array.from(e.target.files||[]).slice(0,4).forEach(f => compressImg(f, d => setAiPhotos(p => [...p, d]))); e.target.value='' }

  const handleCarChange = async carId => {
    set('car_id', carId)
    const car = cars?.find(c => c.id === carId)
    if (car) {
      set('make', car.make||''); set('model', car.model||''); set('year', car.year||'')
      // Auto-fill the SKU from the store's format if one hasn't been set yet
      if (!form.sku && storeId) {
        const { data, error } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: car.make || null })
        if (!error && data) set('sku', data)
      }
    }
  }

  const handleGenerateDesc = async () => {
    setGenerating(true); setAiError('')
    try { const desc = await generateAIDescription(form, aiSettings, footer, storeId); set('description', desc); set('ai_assessed', true) }
    catch(e) { setAiError(e.message) }
    setGenerating(false)
  }

  const handleAIQuickAdd = async () => {
    if (!aiPhotos.length) { setAiError('Add at least one photo for AI analysis'); return }
    setAnalysing(true); setAiError('')
    try {
      const car = cars?.find(c => c.id === form.car_id)
      const parsed = await analysePart({ photoBase64s: aiPhotos.map(p => p.split(',')[1]), carId: car?.id }, car||form, storeId)
      setForm(f => ({ ...f, title:parsed.title||f.title, category:parsed.category||f.category, subcategory:parsed.subcategory||f.subcategory, condition:parsed.condition||f.condition, description:parsed.description||f.description, partNumber:parsed.partNumber||f.partNumber, listPrice:parsed.listPrice||f.listPrice, weight:parsed.weight||f.weight, removalMinutes:parsed.removalMinutes??f.removalMinutes, costs:parsed.sizeTier?COST_TIERS[parsed.sizeTier]||f.costs:f.costs, ai_assessed:true }))
    } catch(e) { setAiError(e.message) }
    setAnalysing(false)
  }

  // Full AI assessment for an existing part using its own saved photo (for
  // parts captured on mobile without AI, or to re-run). Fills all listing fields.
  const partPhotoUrls = (form.photos || []).map(urlFrom).filter(Boolean)
  const partPhotoUrl = partPhotoUrls[0]
  const handleFullAI = async () => {
    if (!partPhotoUrls.length) { setAiError('This part has no photo to assess'); return }
    setAnalysing(true); setAiError('')
    try {
      const car = cars?.find(c => c.id === form.car_id)
      const parsed = await analysePart({ photoUrls: partPhotoUrls, carId: car?.id }, car||form, storeId)
      setForm(f => ({ ...f, title:parsed.title||f.title, category:parsed.category||f.category, subcategory:parsed.subcategory||f.subcategory, condition:parsed.condition||f.condition, description:parsed.description||f.description, partNumber:parsed.partNumber||f.partNumber, listPrice:parsed.listPrice||f.listPrice, weight:parsed.weight||f.weight, removalMinutes:parsed.removalMinutes??f.removalMinutes, costs:parsed.sizeTier?COST_TIERS[parsed.sizeTier]||f.costs:f.costs, ai_assessed:true }))
    } catch(e) { setAiError(e.message) }
    setAnalysing(false)
  }

  const handleSave = () => onSave({ ...form, list_price:+form.listPrice||0, sold_price:form.soldPrice?+form.soldPrice:null })
  const handleSaveAndAdd = () => onSaveAndAdd({ ...form, list_price:+form.listPrice||0, sold_price:form.soldPrice?+form.soldPrice:null })

  const titleLen = (form.title||'').length
  const ebayBtn = (kind='primary') => kind==='primary'
    ? { background:EBAY_BLUE, color:'#fff', border:'none', borderRadius:24, padding:'11px 26px', fontSize:14, fontWeight:700, cursor:'pointer' }
    : { background:'#fff', color:EBAY_BLUE, border:`1.5px solid ${EBAY_BLUE}`, borderRadius:24, padding:'11px 22px', fontSize:14, fontWeight:600, cursor:'pointer' }

  return (
    <div style={{ maxWidth: 820, paddingBottom: 84 }}>
      {uncheckedWarning && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ ...S.card, maxWidth:400, width:'90%', textAlign:'center', borderColor:C.yellow, borderWidth:2 }}>
            <div style={{ fontSize:28, marginBottom:10 }}>⚠️</div>
            <div style={{ fontSize:16, fontWeight:700, marginBottom:8 }}>Remove AI Assessed flag?</div>
            <div style={{ fontSize:13, color:C.muted, marginBottom:16, lineHeight:1.6 }}>This part may be overwritten in the next bulk AI run.</div>
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              <button style={S.btn('secondary')} onClick={() => setUncheckedWarning(false)}>Cancel</button>
              <button style={{ ...S.btn(), background:C.yellow }} onClick={() => { set('ai_assessed', false); setUncheckedWarning(false) }}>Yes, Remove Flag</button>
            </div>
          </div>
        </div>
      )}

      {/* eBay-style header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
        <div>
          <h2 style={{ ...S.h1, marginBottom:2 }}>{part ? 'Edit your listing' : 'Create your listing'}</h2>
          <div style={{ fontSize:13, color:C.muted }}>Build the eBay draft — review every section before listing.</div>
        </div>
        <button style={S.btn('secondary')} onClick={onCancel}>Cancel</button>
      </div>

      {/* Photos / AI Quick Add — eBay puts photos first */}
      {!part && (
        <Section title="Photos" hint="Add a photo and AI fills in the listing details." accent="#7c3aed"
          action={<span style={{ fontSize:12, fontWeight:700, color:'#7c3aed' }}>✨ AI Quick Add</span>}>
          <input ref={photoRef} type="file" accept="image/*" multiple style={{ display:'none' }} onChange={handlePhoto} />
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
            {aiPhotos.map((p,i) => (
              <div key={i} style={{ position:'relative', width:84, height:84 }}>
                <img src={p} style={{ width:84, height:84, borderRadius:8, objectFit:'cover', border:`1px solid ${C.border}` }} />
                <button onClick={() => setAiPhotos(ps => ps.filter((_,j) => j!==i))} style={{ position:'absolute', top:-6, right:-6, background:C.red, border:'none', color:'#fff', borderRadius:'50%', width:20, height:20, fontSize:11, cursor:'pointer', padding:0, lineHeight:'20px' }}>×</button>
              </div>
            ))}
            <button onClick={() => photoRef.current.click()} style={{ width:84, height:84, borderRadius:8, border:`2px dashed ${C.border}`, background:'#fafafa', cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2, fontSize:11, color:C.muted, fontWeight:600 }}>
              <span style={{ fontSize:22 }}>📷</span>{aiPhotos.length ? 'Add' : 'Add photo'}
            </button>
          </div>
          {aiError && <div style={{ fontSize:12, color:C.red, marginTop:10 }}>{aiError}</div>}
          {aiPhotos.length > 0 && (
            <button style={{ ...ebayBtn('secondary'), marginTop:14, padding:'8px 18px', fontSize:13, borderColor:'#7c3aed', color:'#7c3aed', opacity:analysing?0.6:1 }} onClick={handleAIQuickAdd} disabled={analysing}>
              {analysing ? '⏳ Analysing…' : '✨ Analyse & fill details'}
            </button>
          )}
        </Section>
      )}

      {/* Full AI assessment for an existing part (e.g. captured on mobile without AI) */}
      {part && partPhotoUrl && (
        <Section title="AI assessment" accent="#7c3aed"
          hint={form.ai_assessed ? 'Already assessed. Re-run to regenerate all details from the photo.' : 'Not yet assessed. Run the full AI to fill title, category, condition, description, part number, price and weight from the part photo.'}
          action={form.ai_assessed
            ? <span style={{ fontSize:12, fontWeight:700, color:'#16a34a' }}>✓ Assessed</span>
            : <span style={{ fontSize:12, fontWeight:700, color:'#d97706' }}>Needs AI</span>}>
          <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
            <img src={partPhotoUrl} style={{ width:72, height:72, borderRadius:8, objectFit:'cover', border:`1px solid ${C.border}` }} />
            <button style={{ ...ebayBtn('secondary'), padding:'8px 18px', fontSize:13, borderColor:'#7c3aed', color:'#7c3aed', opacity:analysing?0.6:1 }} onClick={handleFullAI} disabled={analysing}>
              {analysing ? '⏳ Assessing…' : (form.ai_assessed ? '✨ Re-run full AI assessment' : '✨ Run full AI assessment')}
            </button>
          </div>
          {aiError && <div style={{ fontSize:12, color:C.red, marginTop:10 }}>{aiError}</div>}
        </Section>
      )}

      {/* eBay listing preview — see the exact category + item specifics + fitment */}
      {part && (
        <Section title="eBay listing preview" accent="#1d4ed8"
          hint="An exact image of what will go to eBay — photos, title, price, description + footer, item specifics and compatible vehicles. No surprises when you list.">
          <button onClick={togglePreview} disabled={previewLoading}
            style={{ ...ebayBtn('secondary'), padding:'8px 18px', fontSize:13, borderColor:'#1d4ed8', color:'#1d4ed8', opacity:previewLoading?0.6:1 }}>
            {previewLoading ? '⏳ Building preview…' : previewOpen ? '▲ Hide listing preview' : '▼ Show full listing preview'}
          </button>
          {previewLoading && <div style={{ fontSize:12, color:C.muted, marginTop:10 }}>Reading eBay's category fields and AI-filling specifics — a few seconds…</div>}
          {previewErr && <div style={{ fontSize:12, color:C.red, marginTop:10 }}>{previewErr}</div>}
          {previewOpen && preview && !previewLoading && (
            <div style={{ marginTop:14 }}>
              {/* Photos */}
              {preview.photos?.length > 0 && (
                <div style={{ display:'flex', gap:6, overflowX:'auto', marginBottom:12, paddingBottom:4 }}>
                  {preview.photos.map((u,i) => (
                    <img key={i} src={u} alt="" style={{ width:72, height:72, borderRadius:8, objectFit:'cover', border:`1px solid ${C.border}`, flexShrink:0 }} />
                  ))}
                </div>
              )}
              {/* Title + price + condition + offers */}
              <div style={{ fontSize:15, fontWeight:700, color:C.text, marginBottom:4 }}>{preview.title || '(no title)'}</div>
              <div style={{ display:'flex', gap:14, flexWrap:'wrap', fontSize:13, marginBottom:12 }}>
                <span style={{ color: preview.price>0?C.text:C.red, fontWeight:700 }}>{preview.price>0 ? fmt(preview.price) : 'No price set'}</span>
                <span style={{ color:C.muted }}>{preview.condition}</span>
                {preview.allowOffers && <span style={{ color:'#1d4ed8' }}>Best Offer on</span>}
                <span style={{ color:C.muted }}>Ship: {Math.round((preview.weightG||0))}g · {preview.dims?.l}×{preview.dims?.w}×{preview.dims?.h}cm</span>
              </div>
              <div style={{ fontSize:13, marginBottom:12 }}>
                <span style={{ color:C.muted }}>eBay category: </span>
                <strong style={{ color:C.text }}>{preview.categoryName || preview.categoryId}</strong>
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, flexWrap:'wrap', gap:8 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.text }}>
                  eBay item specifics — {Object.values(specEdits).filter(Boolean).length} of {preview.specifics?.length||0} filled
                  <span style={{ fontWeight:400, color:C.muted }}> · ★ required · 🚩 your override · editable</span>
                </div>
                <button onClick={saveSpecs} disabled={savingSpecs || !ovDirty}
                  style={{ ...S.btn(specsSaved?'success':'primary'), padding:'5px 14px', fontSize:12, opacity:(savingSpecs||!ovDirty)?0.5:1 }}>
                  {savingSpecs ? 'Saving…' : specsSaved ? '✓ Saved' : 'Save corrections'}
                </button>
              </div>
              <div style={{ border:`1px solid ${C.border}`, borderRadius:8, overflow:'hidden', marginBottom:14 }}>
                {[...(preview.specifics||[])].sort((a,b)=>(b.required-a.required)||((b.value?1:0)-(a.value?1:0))).map((s,i,arr) => {
                  const isOverride = s.overridden || ((specEdits[s.name]||'') !== (specBaseline[s.name]||''))
                  return (
                  <div key={s.name} style={{ display:'flex', alignItems:'center', fontSize:13, padding:'5px 10px', background:i%2?'#fafafa':'#fff', borderBottom:i<arr.length-1?`1px solid ${C.border}`:'none' }}>
                    <div style={{ flex:'0 0 42%', color:C.muted, paddingRight:8 }}>
                      {s.required && <span title="Required by eBay" style={{ color:'#d97706', marginRight:4 }}>★</span>}{s.name}
                    </div>
                    <div style={{ flex:1, display:'flex', alignItems:'center', gap:6 }}>
                      {s.options?.length ? (
                        <select value={specEdits[s.name]||''} onChange={e=>setSpec(s.name, e.target.value)}
                          style={{ ...S.select, flex:1, fontSize:12, padding:'4px 6px' }}>
                          <option value="">— (none)</option>
                          {!s.options.includes(specEdits[s.name]) && specEdits[s.name] && <option value={specEdits[s.name]}>{specEdits[s.name]} (custom)</option>}
                          {s.options.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input value={specEdits[s.name]||''} onChange={e=>setSpec(s.name, e.target.value)} placeholder="—"
                          style={{ ...S.input, flex:1, fontSize:12, padding:'4px 6px' }} />
                      )}
                      {isOverride && <span title="Your override (wins over AI)" style={{ cursor:'default' }}>🚩</span>}
                    </div>
                  </div>
                )})}
                {!preview.specifics?.length && <div style={{ fontSize:12, color:C.muted, padding:'8px 10px' }}>No specifics returned (category may not require any).</div>}
              </div>
              <div style={{ fontSize:12, fontWeight:700, color:C.text, marginBottom:6 }}>Compatible vehicles ({fitEdits.length}) — editable</div>
              <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:8 }}>
                {fitEdits.map((f,i) => (
                  <div key={i} style={{ display:'flex', gap:6, alignItems:'center' }}>
                    <input value={f.make} onChange={e=>setFit(i,'make',e.target.value)} placeholder="Make" style={{ ...S.input, flex:'1 1 22%', fontSize:12, padding:'4px 6px' }} />
                    <input value={f.model} onChange={e=>setFit(i,'model',e.target.value)} placeholder="Model" style={{ ...S.input, flex:'1 1 26%', fontSize:12, padding:'4px 6px' }} />
                    <input value={f.yearFrom} onChange={e=>setFit(i,'yearFrom',e.target.value)} placeholder="From" type="number" style={{ ...S.input, width:62, fontSize:12, padding:'4px 6px' }} />
                    <input value={f.yearTo} onChange={e=>setFit(i,'yearTo',e.target.value)} placeholder="To" type="number" style={{ ...S.input, width:62, fontSize:12, padding:'4px 6px' }} />
                    <input value={f.trim} onChange={e=>setFit(i,'trim',e.target.value)} placeholder="Trim (opt)" style={{ ...S.input, flex:'1 1 18%', fontSize:12, padding:'4px 6px' }} />
                    <button onClick={()=>removeFit(i)} title="Remove" style={{ background:'none', border:'none', color:C.red, cursor:'pointer', fontSize:16, padding:'0 4px' }}>×</button>
                  </div>
                ))}
                {!fitEdits.length && <div style={{ fontSize:12, color:C.muted }}>No vehicles yet — add the ones this part fits.</div>}
              </div>
              <button onClick={addFit} style={{ ...S.btn('secondary'), padding:'5px 12px', fontSize:12 }}>+ Add vehicle</button>

              <div style={{ fontSize:11, color:C.muted, marginTop:12 }}>The description + store footer are shown in the Description section below, exactly as they'll appear on eBay. Edits to specifics/vehicles are saved as overrides and win over the AI when you publish.</div>
            </div>
          )}
        </Section>
      )}

      {/* Title & details */}
      <Section title="Title & details" hint="The title buyers see in search results.">
        {cars && cars.length > 0 && (
          <Field label="Link to Car">
            <select style={S.select} value={form.car_id||''} onChange={e => handleCarChange(e.target.value)}>
              <option value="">— No car linked —</option>
              {cars.map(c => <option key={c.id} value={c.id}>{c.make} {c.model} {c.year}</option>)}
            </select>
          </Field>
        )}
        <Field label="Listing title">
          <input style={{ ...S.input, fontWeight:600 }} maxLength={80} value={form.title||''} onChange={e => set('title', e.target.value)} placeholder="e.g. Toyota Hilux 2018 Headlight RH Genuine OEM" />
          <div style={{ textAlign:'right', fontSize:11, color:titleLen>80?C.red:C.muted, marginTop:4 }}>{titleLen}/80</div>
        </Field>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="SKU">
            <div style={{ display:'flex', gap:6 }}>
              <input style={{ ...S.input, flex:1 }} value={form.sku||''} onChange={e => set('sku', e.target.value)} placeholder="Auto-generates when you link a car" />
              <button type="button" onClick={async () => {
                if (!storeId) return
                const car = cars?.find(c => c.id === form.car_id)
                const { data, error } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: car?.make || null })
                if (!error && data) set('sku', data)
              }} style={{ ...S.btn('secondary'), padding:'0 14px', whiteSpace:'nowrap' }}>Generate</button>
            </div>
          </Field>
          <Field label="OEM Part Number"><input style={S.input} value={form.partNumber||''} onChange={e => set('partNumber', e.target.value)} /></Field>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="Category">
            <select style={S.select} value={form.category||defCat} onChange={e => { set('category', e.target.value); set('subcategory', EBAY_AU_CATEGORIES[e.target.value]?.[0]||'') }}>
              {CATEGORY_NAMES.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Subcategory">
            <select style={S.select} value={form.subcategory||''} onChange={e => set('subcategory', e.target.value)}>
              {(EBAY_AU_CATEGORIES[form.category]||[]).map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {/* Item specifics — vehicle fitment */}
      <Section title="Item specifics" hint="Compatibility buyers filter on.">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
          <Field label="Make">
            <select style={S.select} value={form.make||''} onChange={e => { set('make', e.target.value); set('model', '') }}>
              <option value="">Select Make</option>
              {MAKES.map(m => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Model">
            <AutoInput value={form.model} onChange={v => set('model', v)} suggestions={MODEL_SUGS[form.make]||[]} placeholder="Model" />
          </Field>
          <Field label="Year"><input style={S.input} value={form.year||''} onChange={e => set('year', e.target.value)} /></Field>
        </div>
      </Section>

      {/* Condition */}
      <Section title="Condition">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="Item condition">
            <select style={S.select} value={form.condition||''} onChange={e => set('condition', e.target.value)}>
              {PART_CONDITIONS.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select style={S.select} value={form.status||'in_stock'} onChange={e => set('status', e.target.value)}>
              {['in_stock','listed','sold','scrapped','deferred'].map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </Field>
        </div>
      </Section>

      {/* Description */}
      <Section title="Description"
        action={
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:12, color:form.ai_assessed?C.green:C.muted }}>
              <input type="checkbox" checked={form.ai_assessed||false}
                onChange={e => { if (!e.target.checked && form.ai_assessed) setUncheckedWarning(true); else set('ai_assessed', e.target.checked) }}
                style={{ accentColor:C.green, width:14, height:14 }} />
              <span style={{ fontWeight:600 }}>AI Assessed {form.ai_assessed?'✓':''}</span>
            </label>
            <button style={{ ...S.btn('blue'), padding:'5px 14px', fontSize:12, borderRadius:20, opacity:generating?0.6:1 }} onClick={handleGenerateDesc} disabled={generating}>
              {generating ? '⏳ Generating…' : '✨ Generate'}
            </button>
          </div>
        }>
        <textarea style={{ ...S.textarea, minHeight:140 }} value={form.description||''} onChange={e => { set('description', e.target.value); if (e.target.value) set('ai_assessed', false) }} placeholder="Describe condition, fitment and any defects…" />
        {footer ? (
          <div style={{ marginTop:10, padding:'10px 12px', background:'#fafafa', border:`1px dashed ${C.border}`, borderRadius:8, fontSize:12, color:C.muted, whiteSpace:'pre-wrap', lineHeight:1.5 }}>
            <div style={{ fontWeight:700, marginBottom:4, color:C.text }}>＋ Store footer (added automatically on publish — edit in Settings → Descriptions)</div>
            {footer}
          </div>
        ) : (
          <div style={{ marginTop:8, fontSize:12, color:'#d97706' }}>No store footer set — add one in Settings → Descriptions so it's appended to your listings.</div>
        )}
      </Section>

      {/* Pricing */}
      <Section title="Pricing" hint="Buy It Now price and your internal cost breakdown.">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
          <Field label="List Price ($)"><input style={{ ...S.input, fontWeight:700, fontSize:16 }} type="number" value={form.listPrice||''} onChange={e => set('listPrice', e.target.value)} /></Field>
          <Field label="Sold Price ($)"><input style={S.input} type="number" value={form.soldPrice||''} onChange={e => set('soldPrice', e.target.value)} /></Field>
          <Field label="Weight (g)"><input style={S.input} type="number" value={form.weight||''} onChange={e => set('weight', e.target.value)} /></Field>
        </div>
        <div style={{ background:'#f9f8f5', border:`1px solid ${C.border}`, borderRadius:10, padding:'14px 16px', marginTop:6 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:12 }}>Cost breakdown (AUD)</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
            {Object.keys(form.costs||{}).map(k => (
              <Field key={k} label={`${k.charAt(0).toUpperCase()+k.slice(1)} ($)`}>
                <input style={S.input} type="number" min="0" step="0.01" value={form.costs[k]||0} onChange={e => setCost(k, e.target.value)} />
              </Field>
            ))}
          </div>
          <div style={{ marginTop:12, paddingTop:12, borderTop:`1px dashed ${C.border}` }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, marginBottom:8, flexWrap:'wrap' }}>
              <div style={{ fontSize:13, fontWeight:700, color:C.text }}>Estimated cost basis (auto)</div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ fontSize:12, color:C.muted }}>Removal mins</span>
                <input style={{ ...S.input, width:80, padding:'6px 8px', fontSize:13 }} type="number" min="0" value={form.removalMinutes||''} onChange={e => set('removalMinutes', e.target.value)} placeholder="—" />
              </div>
            </div>
            <div style={{ display:'flex', gap:16, flexWrap:'wrap', fontSize:12, color:C.muted }}>
              <span>Car share: <strong style={{ color:C.text }}>{fmt(basis.carShare)}</strong></span>
              <span>Removal labour: <strong style={{ color:C.text }}>{fmt(basis.labour)}</strong></span>
              <span>Admin: <strong style={{ color:C.text }}>{fmt(basis.admin)}</strong></span>
              <span>Auto basis: <strong style={{ color:C.text }}>{fmt(basis.total)}</strong></span>
            </div>
          </div>
          <div style={{ display:'flex', gap:20, marginTop:12, fontSize:12 }}>
            <span>Total cost: <strong style={{ color:C.red }}>{fmt(cost)}</strong></span>
            <span>Profit: <strong style={{ color:profit>=0?C.green:C.red }}>{fmt(profit)}</strong></span>
            <span>Margin: <strong style={{ color:margin>=30?C.green:C.yellow }}>{pct(margin)}</strong></span>
          </div>
        </div>
      </Section>

      {/* Record keeping */}
      <Section title="Record keeping">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="Acquired Date"><input style={S.input} type="date" value={form.acquiredDate||''} onChange={e => set('acquiredDate', e.target.value)} /></Field>
          <Field label="Notes"><input style={S.input} value={form.notes||''} onChange={e => set('notes', e.target.value)} /></Field>
        </div>
      </Section>

      {/* eBay-style sticky action bar */}
      <div style={{ position:'sticky', bottom:0, marginTop:8, marginLeft:-2, marginRight:-2, background:'rgba(255,255,255,0.92)', backdropFilter:'blur(6px)', borderTop:`1px solid ${C.border}`, padding:'14px 4px', display:'flex', gap:12, justifyContent:'flex-end', alignItems:'center' }}>
        <span style={{ fontSize:12, color:C.muted, marginRight:'auto' }}>Saved as draft — not published to eBay until you list it.</span>
        <button style={ebayBtn('secondary')} onClick={onCancel}>Cancel</button>
        {!part && <button style={ebayBtn('secondary')} onClick={handleSaveAndAdd}>Save & add another</button>}
        <button style={ebayBtn('primary')} onClick={handleSave}>{part ? 'Save changes' : 'Save draft'}</button>
      </div>
    </div>
  )
}

// ─── Bulk AI Panel ─────────────────────────────────────────────────────────
function BulkAIPanel({ group, onComplete, aiSettings, footer, storeId }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done:0, total:0, current:'' })
  const [done, setDone] = useState(false)
  const needsAI = group.parts.filter(p => !p.ai_assessed)

  const runBulk = async () => {
    setRunning(true); setDone(false)
    setProgress({ done:0, total:needsAI.length, current:'' })
    for (let i = 0; i < needsAI.length; i++) {
      const part = needsAI[i]
      setProgress({ done:i, total:needsAI.length, current:part.title||'Part' })
      try {
        const desc = await generateAIDescription(part, aiSettings, footer, storeId)
        await sb.from('parts').update({ description:desc, ai_assessed:true }).eq('id', part.id)
      } catch(e) { console.error('Failed for part', part.id, e) }
      await new Promise(r => setTimeout(r, 500))
    }
    setProgress(p => ({ ...p, done:needsAI.length, current:'' }))
    setRunning(false); setDone(true); onComplete()
  }

  return (
    <div style={{ background:'#eff6ff', border:`1px solid #bfdbfe`, borderRadius:10, padding:16, marginBottom:12 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:14, color:C.blue }}>✨ AI Descriptions — {group.make} {group.model} {group.year}</div>
          <div style={{ fontSize:12, color:C.muted, marginTop:3 }}>{needsAI.length} part{needsAI.length!==1?'s':''} without AI · {group.parts.length-needsAI.length} done</div>
        </div>
        <button style={{ ...S.btn('blue'), padding:'6px 14px', fontSize:12, opacity:running||needsAI.length===0?0.5:1 }} disabled={running||needsAI.length===0} onClick={runBulk}>
          {running ? `⏳ ${progress.done}/${progress.total}` : `✨ Generate All (${needsAI.length})`}
        </button>
      </div>
      {running && (
        <div style={{ marginTop:12 }}>
          <div style={{ height:6, background:'#dbeafe', borderRadius:3, overflow:'hidden' }}>
            <div style={{ height:'100%', background:C.blue, borderRadius:3, width:`${(progress.done/progress.total)*100}%`, transition:'width .3s' }} />
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>Processing: {progress.current}</div>
        </div>
      )}
      {done && <div style={{ fontSize:12, color:C.green, marginTop:8, fontWeight:600 }}>✓ All descriptions generated</div>}
    </div>
  )
}

// ─── Main Inventory ────────────────────────────────────────────────────────
export default function Inventory({ parts, cars, onAdd, onEdit, onDelete, onDeleteCar, onAddCar, storeId, aiSettings, footer, costing }) {
  const [viewMode, setViewMode] = useState('parts')
  const [search, setSearch] = useState('')
  const [filterMake, setFilterMake] = useState('')
  const [filterModel, setFilterModel] = useState('')
  const [filterYear, setFilterYear] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterCond, setFilterCond] = useState('')
  const [hideSold, setHideSold] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [newOnly, setNewOnly] = useState(false)
  const [newWindow, setNewWindow] = useState(24) // hours; default last 24h
  const [showForm, setShowForm] = useState(false)
  const [editingPart, setEditingPart] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteCarTarget, setDeleteCarTarget] = useState(null)
  const [expandedCars, setExpandedCars] = useState(new Set())
  const [bulkAIGroup, setBulkAIGroup] = useState(null)
  const [showAddCar, setShowAddCar] = useState(false)
  const [page, setPage] = useState(0)
  const PAGE = 100

  const makes = useMemo(() => [...new Set(parts.filter(p=>p.make).map(p=>p.make))].sort(), [parts])
  const models = useMemo(() => { const src=filterMake?parts.filter(p=>p.make===filterMake):parts; return [...new Set(src.filter(p=>p.model).map(p=>p.model))].sort() }, [parts, filterMake])

  const filtered = useMemo(() => parts.filter(p => {
    if (hideSold && p.status === 'sold') return false
    const q=search.toLowerCase()
    if (q&&![p.title,p.make,p.model,p.year,p.sku,p.partNumber,p.category,p.subcategory,p.condition,p.status].some(v=>(v||'').toLowerCase().includes(q))) return false
    if (filterMake&&p.make!==filterMake) return false
    if (filterModel&&p.model!==filterModel) return false
    if (filterYear&&!(p.year||'').includes(filterYear)) return false
    if (filterCat&&p.category!==filterCat) return false
    if (filterStatus&&p.status!==filterStatus) return false
    if (filterCond&&p.condition!==filterCond) return false
    if (newOnly && (!p.createdAt || new Date(p.createdAt).getTime() < Date.now() - newWindow*3600*1000)) return false
    return true
  }), [parts,search,filterMake,filterModel,filterYear,filterCat,filterStatus,filterCond,hideSold,showDeleted,newOnly,newWindow])

  const carGroups = useMemo(() => {
    const g={}
    filtered.forEach(p => {
      const key=[p.make||'Unknown',p.model||'',p.year||'',p.car_id||''].join('|')
      if (!g[key]) g[key]={make:p.make||'Unknown',model:p.model||'',year:p.year||'',carId:p.car_id||null,parts:[]}
      g[key].parts.push(p)
    })
    return Object.values(g).sort((a,b)=>(a.make+a.model).localeCompare(b.make+b.model))
  }, [filtered])

  const paged = useMemo(() => filtered.slice(page*PAGE,(page+1)*PAGE), [filtered,page])
  const pages = Math.ceil(filtered.length/PAGE)
  const totals = filtered.reduce((acc,p) => { const c=totalCost(p),lp=+p.list_price||0; return{cost:acc.cost+c,list:acc.list+lp,profit:acc.profit+(lp-c),sold:acc.sold+(+p.soldPrice||0),count:acc.count+1} }, {cost:0,list:0,profit:0,sold:0,count:0})
  const clearFilters = () => { setSearch('');setFilterMake('');setFilterModel('');setFilterYear('');setFilterCat('');setFilterStatus('');setFilterCond('');setPage(0) }
  const handleDeleteCar = async group => { await onDeleteCar(group.carId||null, group.parts.map(p=>p.id)); setDeleteCarTarget(null) }

  const inputSm = { ...S.input, height:30, padding:'0 8px', fontSize:12 }
  const selSm = { ...S.select, height:30, padding:'0 8px', fontSize:12 }

  const handleSaveAndAdd = async p => {
    await onAdd(p)
    setEditingPart(null); setShowForm(false)
    setTimeout(() => setShowForm(true), 50)
  }

  if (showForm) return (
    <PartForm part={editingPart} cars={cars} storeId={storeId} aiSettings={aiSettings} footer={footer} costing={costing} allParts={parts}
      onSave={async p => { editingPart?await onEdit({...editingPart,...p}):await onAdd(p); setShowForm(false); setEditingPart(null) }}
      onSaveAndAdd={handleSaveAndAdd}
      onCancel={() => { setShowForm(false); setEditingPart(null) }}
    />
  )

  return (
    <div>
      {showAddCar && <AddCarModal storeId={storeId} onSave={car => { onAddCar(car); setShowAddCar(false) }} onCancel={() => setShowAddCar(false)} />}

      {deleteCarTarget && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ ...S.card, maxWidth:440, width:'90%', borderColor:C.red, borderWidth:2 }}>
            <div style={{ fontSize:28, marginBottom:10, textAlign:'center' }}>⚠️⚠️⚠️</div>
            <div style={{ fontSize:17, fontWeight:700, color:C.text, marginBottom:8, textAlign:'center' }}>Delete this car and all its parts?</div>
            <div style={{ background:'#fef2f2', borderRadius:8, padding:14, marginBottom:16, fontSize:14, color:C.red, lineHeight:1.7 }}>
              <strong>{deleteCarTarget.make} {deleteCarTarget.model} {deleteCarTarget.year}</strong><br/>Soft-deletes <strong>{deleteCarTarget.parts.length} parts</strong>.
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              <button style={S.btn('secondary')} onClick={() => setDeleteCarTarget(null)}>Cancel</button>
              <button style={S.btn('danger')} onClick={() => handleDeleteCar(deleteCarTarget)}>Delete Car + {deleteCarTarget.parts.length} Parts</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ ...S.card, maxWidth:380, width:'90%', textAlign:'center', borderColor:C.red, borderWidth:2 }}>
            <div style={{ fontSize:28, marginBottom:10 }}>⚠️</div>
            <div style={{ fontSize:17, fontWeight:700, color:C.text, marginBottom:6 }}>Delete this part?</div>
            <div style={{ fontSize:13, color:C.muted, marginBottom:16 }}>"{deleteTarget.title}"</div>
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              <button style={S.btn('secondary')} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button style={S.btn('danger')} onClick={() => { onDelete(deleteTarget.id); setDeleteTarget(null) }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:8, marginBottom:12, alignItems:'center', flexWrap:'wrap' }}>
        <h2 style={{ ...S.h1, margin:0 }}>Inventory</h2>
        <div style={{ width:1, height:22, background:C.border }} />
        <button style={{ ...S.btn(), background:C.blue }} onClick={() => setShowAddCar(true)}>🚗 Add Car</button>
        <button style={S.btn()} onClick={() => { setEditingPart(null); setShowForm(true) }}>+ Add Part</button>
        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ display:'flex', borderRadius:8, overflow:'hidden', border:`1.5px solid ${C.border}` }}>
            <button onClick={() => setViewMode('parts')} style={{ padding:'5px 14px', fontSize:12, fontWeight:600, background:viewMode==='parts'?C.accent:'white', color:viewMode==='parts'?'white':C.muted, border:'none', cursor:'pointer' }}>📦 By Part</button>
            <button onClick={() => setViewMode('car')} style={{ padding:'5px 14px', fontSize:12, fontWeight:600, background:viewMode==='car'?C.accent:'white', color:viewMode==='car'?'white':C.muted, border:'none', cursor:'pointer', borderLeft:`1px solid ${C.border}` }}>🚗 By Car</button>
          </div>
          <span style={{ fontSize:12, color:C.muted, background:C.panel, borderRadius:10, padding:'2px 10px', fontWeight:600 }}>{totals.count} parts</span>
        </div>
      </div>

      <div style={{ display:'flex', gap:12, marginBottom:14, flexWrap:'wrap' }}>
        {[['Stock Value',`$${totals.list.toFixed(0)}`,C.blue],['Total Cost',`$${totals.cost.toFixed(0)}`,C.red],['Est. Profit',`$${totals.profit.toFixed(0)}`,totals.profit>=0?C.green:C.red],['Sold Revenue',`$${totals.sold.toFixed(0)}`,C.accent]].map(([l,v,col])=>(
          <div key={l} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 16px', borderTop:`3px solid ${col}` }}>
            <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:'0.5px' }}>{l}</div>
            <div style={{ fontSize:20, fontWeight:800, color:col }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:'12px 16px', marginBottom:14 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8, flexWrap:'wrap' }}>
          <input style={{ ...inputSm, flex:2, minWidth:200 }} placeholder="🔍 Search everything..." value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
          <button onClick={clearFilters} style={{ ...S.btn('secondary'), padding:'0 12px', height:30, fontSize:12 }}>Clear</button>
          <span style={{ fontSize:12, color:C.muted }}>{filtered.length} matching</span>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <select style={{ ...selSm, minWidth:110 }} value={filterMake} onChange={e => { setFilterMake(e.target.value); setFilterModel(''); setPage(0) }}>
            <option value="">All Makes</option>{makes.map(m=><option key={m}>{m}</option>)}
          </select>
          <select style={{ ...selSm, minWidth:110 }} value={filterModel} onChange={e => { setFilterModel(e.target.value); setPage(0) }}>
            <option value="">All Models</option>{models.map(m=><option key={m}>{m}</option>)}
          </select>
          <input style={{ ...inputSm, width:80 }} placeholder="Year..." value={filterYear} onChange={e => { setFilterYear(e.target.value); setPage(0) }} />
          <select style={{ ...selSm, minWidth:160 }} value={filterCat} onChange={e => { setFilterCat(e.target.value); setPage(0) }}>
            <option value="">All Categories</option>{CATEGORY_NAMES.map(c=><option key={c}>{c}</option>)}
          </select>
          <select style={{ ...selSm, minWidth:110 }} value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(0) }}>
            <option value="">All Statuses</option>
            {['in_stock','listed','sold','scrapped','deferred'].map(s => (
              <option key={s} value={s} disabled={hideSold && s === 'sold'} style={hideSold && s === 'sold' ? { color: C.muted } : {}}>
                {STATUS_LABELS[s]}{hideSold && s === 'sold' ? ' (hidden)' : ''}
              </option>
            ))}
          </select>
          <select style={{ ...selSm, minWidth:130 }} value={filterCond} onChange={e => { setFilterCond(e.target.value); setPage(0) }}>
            <option value="">All Conditions</option>{PART_CONDITIONS.map(c=><option key={c}>{c}</option>)}
          </select>
          <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:C.muted, cursor:'pointer', userSelect:'none' }}>
            <input
              type="checkbox"
              checked={hideSold}
              onChange={e => { setHideSold(e.target.checked); if (e.target.checked && filterStatus === 'sold') setFilterStatus(''); setPage(0) }}
              style={{ cursor:'pointer' }}
            />
            Hide Sold
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:C.muted, cursor:'pointer', userSelect:'none' }}>
            <input type="checkbox" checked={newOnly} onChange={e => { setNewOnly(e.target.checked); setPage(0) }} style={{ cursor:'pointer' }} />
            🆕 New only
          </label>
          {newOnly && (
            <select style={{ ...selSm, minWidth:120 }} value={newWindow} onChange={e => { setNewWindow(+e.target.value); setPage(0) }}>
              <option value={24}>Last 24 hours</option>
              <option value={72}>Last 3 days</option>
              <option value={168}>Last 7 days</option>
              <option value={720}>Last 30 days</option>
            </select>
          )}
        </div>
      </div>

      {viewMode==='car' && (
        <div>
          <div style={{ display:'flex', gap:8, marginBottom:10, alignItems:'center' }}>
            <span style={{ fontSize:13, color:C.muted }}>{carGroups.length} car{carGroups.length!==1?'s':''}</span>
            <button onClick={() => setExpandedCars(new Set(carGroups.map(g=>g.make+'|'+g.model+'|'+g.year+'|'+(g.carId||''))))} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11 }}>Expand All</button>
            <button onClick={() => setExpandedCars(new Set())} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11 }}>Collapse All</button>
          </div>
          {bulkAIGroup && <BulkAIPanel group={bulkAIGroup} aiSettings={aiSettings} footer={footer} storeId={storeId} onComplete={() => setBulkAIGroup(null)} />}
          {carGroups.map(g => {
            const key=g.make+'|'+g.model+'|'+g.year+'|'+(g.carId||'')
            const isOpen=expandedCars.has(key)
            const gList=g.parts.reduce((a,p)=>a+(+p.list_price||0),0)
            const gCost=g.parts.reduce((a,p)=>a+totalCost(p),0)
            const gProfit=gList-gCost
            const gStock=g.parts.filter(p=>p.status==='in_stock').length
            const gListed=g.parts.filter(p=>p.status==='listed').length
            const gSold=g.parts.filter(p=>p.status==='sold').length
            const aiPending=g.parts.filter(p=>!p.ai_assessed).length
            return (
              <div key={key} style={{ ...S.card, marginBottom:8, padding:0, overflow:'hidden' }}>
                <div onClick={() => setExpandedCars(s=>{const n=new Set(s);n.has(key)?n.delete(key):n.add(key);return n})} style={{ display:'flex', alignItems:'center', padding:'12px 16px', cursor:'pointer', background:'#f9f8f5', gap:12, flexWrap:'wrap' }}>
                  <span style={{ fontSize:18 }}>{isOpen?'▼':'▶'}</span>
                  <div style={{ flex:1, minWidth:200 }}>
                    <div style={{ fontWeight:700, fontSize:16, color:C.text }}>{g.make} {g.model} {g.year&&`'${String(g.year).slice(-2)}`}</div>
                    <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{g.parts.length} parts · {gStock} in stock · {gListed} listed · {gSold} sold{aiPending>0&&<span style={{ color:C.blue, marginLeft:8 }}>· {aiPending} need AI</span>}</div>
                  </div>
                  <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                    {[['Stock Value',`$${gList.toFixed(0)}`,C.blue],['Cost',`$${gCost.toFixed(0)}`,C.red],['Profit',`$${gProfit.toFixed(0)}`,gProfit>=0?C.green:C.red]].map(([l,v,col])=>(
                      <div key={l} style={{ textAlign:'center' }}><div style={{ fontSize:10, color:C.muted, textTransform:'uppercase' }}>{l}</div><div style={{ fontSize:15, fontWeight:700, color:col }}>{v}</div></div>
                    ))}
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    {aiPending>0&&<button onClick={e=>{e.stopPropagation();setBulkAIGroup(g)}} style={{ ...S.btn('blue'), padding:'5px 12px', fontSize:12, flexShrink:0 }}>✨ AI ({aiPending})</button>}
                    <button onClick={e=>{e.stopPropagation();setDeleteCarTarget(g)}} style={{ ...S.btn('danger'), padding:'5px 12px', fontSize:12, flexShrink:0 }}>🗑 Delete Car</button>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ borderTop:`1px solid ${C.border}` }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                      <thead>
                        <tr style={{ background:'#f5f4f0' }}>
                          {['Title','Category','Condition','Status','AI','List $','Cost','Profit',''].map(h=>(
                            <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontSize:11, fontWeight:700, textTransform:'uppercase', color:C.muted, borderBottom:`1px solid ${C.border}`, whiteSpace:'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {g.parts.map((p,i)=>{
                          const cost=totalCost(p),lp=+p.list_price||0,pr=lp-cost
                          const stCol=STATUS_COLORS[p.status]||C.muted
                          return (
                            <tr key={p.id} style={{ background:i%2===0?'white':'#faf9f7', borderBottom:`1px solid ${C.border}` }}>
                              <td style={{ padding:'8px 12px', maxWidth:260, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                <span title={p.title} style={{ fontWeight:500 }}>{p.title||'Untitled'}</span>
                                {p.partNumber&&<span style={{ fontSize:11, color:C.muted, marginLeft:8 }}>#{p.partNumber}</span>}
                              </td>
                              <td style={{ padding:'8px 12px', fontSize:12, color:C.muted, whiteSpace:'nowrap' }}>{p.subcategory||p.category}</td>
                              <td style={{ padding:'8px 12px', fontSize:12, color:C.muted, whiteSpace:'nowrap' }}>{p.condition}</td>
                              <td style={{ padding:'8px 12px' }}><span style={{ ...S.pill(stCol), fontSize:11 }}>{STATUS_LABELS[p.status]||p.status}</span></td>
                              <td style={{ padding:'8px 12px', textAlign:'center' }}><span title={p.ai_assessed?'AI Assessed':'Needs AI'}>{p.ai_assessed?'✅':'⬜'}</span></td>
                              <td style={{ padding:'8px 12px', fontWeight:700, whiteSpace:'nowrap' }}>${lp.toFixed(0)}</td>
                              <td style={{ padding:'8px 12px', color:C.red, whiteSpace:'nowrap' }}>${cost.toFixed(0)}</td>
                              <td style={{ padding:'8px 12px', fontWeight:600, color:pr>=0?C.green:C.red, whiteSpace:'nowrap' }}>${pr.toFixed(0)}</td>
                              <td style={{ padding:'8px 12px', whiteSpace:'nowrap' }}>
                                <button onClick={()=>{setEditingPart(p);setShowForm(true)}} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11, marginRight:6 }}>Edit</button>
                                <button onClick={()=>setDeleteTarget(p)} style={{ ...S.btn('danger'), padding:'3px 8px', fontSize:11 }}>🗑</button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
          {!carGroups.length&&<div style={{ textAlign:'center', color:C.muted, padding:60, fontSize:15 }}>No cars match your filters.</div>}
        </div>
      )}

      {viewMode==='parts' && (
        <div>
          {pages>1&&(
            <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
              <button disabled={page===0} onClick={()=>setPage(p=>p-1)} style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12 }}>← Prev</button>
              <span style={{ fontSize:13, color:C.muted }}>Page {page+1} of {pages} ({filtered.length} parts)</span>
              <button disabled={page===pages-1} onClick={()=>setPage(p=>p+1)} style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12 }}>Next →</button>
            </div>
          )}
          <div style={{ overflowX:'auto', borderRadius:6, border:`1px solid ${C.border}` }}>
            <table style={{ borderCollapse:'collapse', fontSize:13, minWidth:1000, width:'100%' }}>
              <thead style={{ position:'sticky', top:0, zIndex:10 }}>
                <tr style={{ background:'#f5f4f0' }}>
                  {[['Edit',60],['SKU',80],['Title',260],['Make',80],['Model',90],['Year',65],['Category',150],['Status',85],['AI',40],['List$',72],['Cost',72],['Profit',72],['Del',50]].map(([h,w])=>(
                    <th key={h} style={{ padding:'8px 8px', textAlign:'left', fontSize:10, fontWeight:700, textTransform:'uppercase', color:C.muted, background:'#f5f4f0', borderBottom:`2px solid ${C.accent}`, borderRight:`1px solid ${C.border}`, minWidth:w, whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((p,i)=>{
                  const cost=totalCost(p),lp=+p.list_price||0,pr=lp-cost
                  const stCol=STATUS_COLORS[p.status]||C.muted
                  const bg=p.deletedAt?'#fff5f5':p.status==='sold'?'#f0fdf4':i%2===0?'#ffffff':'#faf9f7'
                  const td=(v,col,bold)=><td style={{ padding:'4px 8px', fontSize:12, color:col||C.text, fontWeight:bold?700:400, borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}`, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', maxWidth:260 }} title={String(v||'')}>{v||<span style={{color:C.border}}>—</span>}</td>
                  return (
                    <tr key={p.id} style={{ background:bg }}>
                      <td style={{ padding:'4px 6px', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}` }}>
                        <button onClick={()=>{setEditingPart(p);setShowForm(true)}} style={{ fontSize:11, padding:'2px 8px', background:'#eff6ff', color:C.blue, border:`1px solid ${C.blue}44`, borderRadius:4, cursor:'pointer' }}>Edit</button>
                      </td>
                      {td(p.sku)}{td(p.title)}{td(p.make)}{td(p.model)}{td(p.year)}{td(p.subcategory||p.category)}
                      <td style={{ padding:'4px 8px', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}` }}>
                        <span style={{ ...S.pill(stCol), fontSize:10, padding:'1px 6px' }}>{STATUS_LABELS[p.status]||p.status}</span>
                      </td>
                      <td style={{ padding:'4px 8px', textAlign:'center', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}` }}>
                        <span title={p.ai_assessed?'AI Assessed':'Needs AI'}>{p.ai_assessed?'✅':'⬜'}</span>
                      </td>
                      {td(lp>0?`$${lp.toFixed(0)}`:'',C.text,true)}
                      {td(`$${cost.toFixed(0)}`,C.red)}
                      {td(`$${pr.toFixed(0)}`,pr>=0?C.green:C.red,true)}
                      <td style={{ padding:'4px 6px', textAlign:'center', borderBottom:`1px solid ${C.border}` }}>
                        <button onClick={()=>setDeleteTarget(p)} style={{ fontSize:11, padding:'2px 6px', background:'#fef2f2', color:C.red, border:`1px solid ${C.red}44`, borderRadius:4, cursor:'pointer' }}>🗑</button>
                      </td>
                    </tr>
                  )
                })}
                {!paged.length&&<tr><td colSpan={13} style={{ textAlign:'center', padding:40, color:C.muted }}>No parts match your filters.</td></tr>}
              </tbody>
              <tfoot>
                <tr style={{ background:'#1c1c1e' }}>
                  <td colSpan={9} style={{ padding:'6px 12px', fontSize:11, color:'rgba(255,255,255,0.5)', fontWeight:600 }}>TOTALS ({totals.count} parts)</td>
                  <td style={{ padding:'6px 8px', textAlign:'right', fontSize:12, fontWeight:700, color:'#93c5fd' }}>${totals.list.toFixed(0)}</td>
                  <td style={{ padding:'6px 8px', textAlign:'right', fontSize:12, fontWeight:700, color:'#fca5a5' }}>${totals.cost.toFixed(0)}</td>
                  <td style={{ padding:'6px 8px', textAlign:'right', fontSize:12, fontWeight:700, color:totals.profit>=0?'#86efac':'#fca5a5' }}>${totals.profit.toFixed(0)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
