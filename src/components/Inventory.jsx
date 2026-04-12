import { useState, useMemo, useRef } from 'react'
import { C, S, fmt, pct, totalCost, CATEGORY_NAMES, EBAY_AU_CATEGORIES, PART_CONDITIONS, AU_SHIPPING, STATUS_COLORS } from '../lib/constants'
import { sb } from '../lib/supabase'

const AI_PROXY = 'https://partvault-proxy.leap00.workers.dev'

const MAKES = ['Toyota','Ford','Holden','Mazda','Hyundai','Kia','Mitsubishi','Nissan','Subaru','Honda','Volkswagen','BMW','Mercedes-Benz','Audi','Land Rover','Isuzu','Suzuki','Lexus','Jeep','Volvo','Other']
const MODEL_SUGS = {Toyota:['Hilux','Camry','Corolla','RAV4','LandCruiser','LandCruiser 200','Prado','HiAce','Kluger','Yaris','Aurion'],Ford:['Ranger','Falcon','Territory','Focus','Fiesta','Escape','Explorer','Mustang','Transit'],Holden:['Commodore','Colorado','Trax','Captiva','Cruze','Astra','Barina','Trailblazer'],Mazda:['CX-5','CX-3','CX-9','CX-7','Mazda3','Mazda6','BT-50','MX-5','RX-7','RX-8'],Hyundai:['i30','Tucson','Santa Fe','i20','Accent','Elantra','Sonata','ix35','Kona'],Kia:['Sportage','Cerato','Rio','Sorento','Carnival','Stinger','Seltos'],Mitsubishi:['Triton','ASX','Outlander','Eclipse Cross','Pajero','Lancer'],Nissan:['Navara','X-Trail','Patrol','Pathfinder','Qashqai','Pulsar','Skyline'],Subaru:['Forester','Outback','Impreza','Liberty','WRX','BRZ','XV'],Honda:['CR-V','HR-V','Jazz','Civic','Accord'],Volkswagen:['Golf','Polo','Tiguan','Passat','Amarok'],BMW:['3 Series','5 Series','7 Series','X3','X5','X1'],'Mercedes-Benz':['C-Class','E-Class','S-Class','GLC','GLE','A-Class'],'Land Rover':['Discovery','Range Rover','Defender'],Isuzu:['D-Max','MU-X'],Suzuki:['Swift','Vitara','Jimny'],Lexus:['RX','NX','GX','IS'],Jeep:['Wrangler','Cherokee','Grand Cherokee'],Volvo:['XC90','XC60','XC40']}

function Field({ label, children }) {
  return <div style={{ marginBottom: 12 }}><label style={S.label}>{label}</label>{children}</div>
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

async function generateAIDescription(part, aiSettings, footer) {
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
  const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }) })
  const data = await resp.json()
  return (data.content?.map(b => b.text || '').join('') || '').trim()
}

async function analysePartPhoto(photoBase64, car) {
  const apiKey = localStorage.getItem('pv_anthropic_key') || ''
  if (!apiKey || apiKey.length < 20) throw new Error('No API key — add it in Settings > Account')
  const sys = `You are an expert Australian used car parts eBay seller. Return JSON only.\nCategories: ${CATEGORY_NAMES.join(', ')}\nReturn: {"title":"max 80 chars","category":"exact","subcategory":"exact","condition":"Used – Good","description":"3-4 sentences","partNumber":"OEM or empty","sizeTier":"small|medium|large|bulky","listPrice":number,"weight":number,"shippingOption":"Standard Post|Express Post|Courier|Collect Only","confidence":"high|medium|low","notes":"any notes"}`
  const res = await fetch(AI_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 800, system: sys, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } }, { type: 'text', text: `Vehicle: ${car?.make||''} ${car?.model||''} ${car?.year||''}. Identify this car part.` }] }] }) })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message)
  const raw = data.content?.filter(b => b.type === 'text').map(b => b.text).join('').trim()
  let parsed; try { parsed = JSON.parse(raw) } catch { const m = raw?.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]) }
  if (!parsed) throw new Error('Could not parse AI response')
  return parsed
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
function PartForm({ part, cars, storeId, onSave, onSaveAndAdd, onCancel, aiSettings, footer }) {
  const defCat = CATEGORY_NAMES[4]
  const [form, setForm] = useState(part ? { ...part, costs: { ...part.costs }, listPrice: part.list_price||part.listPrice||0, ai_assessed: part.ai_assessed??false } : {
    title:'', category:defCat, subcategory:EBAY_AU_CATEGORIES[defCat][0], make:'', model:'', year:'', condition:PART_CONDITIONS[1],
    description:'', acquiredDate:'', costs:defCosts(), listPrice:'', soldPrice:'', photos:[], weight:'', status:'In Stock',
    partNumber:'', shippingOption:AU_SHIPPING[0], notes:'', ai_assessed:false, car_id:null,
  })
  const [generating, setGenerating] = useState(false)
  const [analysing, setAnalysing] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiPhotos, setAiPhotos] = useState([])
  const [uncheckedWarning, setUncheckedWarning] = useState(false)
  const photoRef = useRef()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setCost = (k, v) => setForm(f => ({ ...f, costs: { ...f.costs, [k]: +v||0 } }))
  const cost = Object.values(form.costs||{}).reduce((a,v) => a+(+v||0), 0)
  const profit = (+form.listPrice||0) - cost
  const margin = +form.listPrice > 0 ? (profit / +form.listPrice) * 100 : 0

  const handlePhoto = e => { Array.from(e.target.files||[]).slice(0,4).forEach(f => compressImg(f, d => setAiPhotos(p => [...p, d]))); e.target.value='' }

  const handleCarChange = carId => {
    set('car_id', carId)
    const car = cars?.find(c => c.id === carId)
    if (car) { set('make', car.make||''); set('model', car.model||''); set('year', car.year||'') }
  }

  const handleGenerateDesc = async () => {
    setGenerating(true); setAiError('')
    try { const desc = await generateAIDescription(form, aiSettings, footer); set('description', desc); set('ai_assessed', true) }
    catch(e) { setAiError(e.message) }
    setGenerating(false)
  }

  const handleAIQuickAdd = async () => {
    if (!aiPhotos.length) { setAiError('Add at least one photo for AI analysis'); return }
    setAnalysing(true); setAiError('')
    try {
      const car = cars?.find(c => c.id === form.car_id)
      const parsed = await analysePartPhoto(aiPhotos[0].split(',')[1], car||form)
      setForm(f => ({ ...f, title:parsed.title||f.title, category:parsed.category||f.category, subcategory:parsed.subcategory||f.subcategory, condition:parsed.condition||f.condition, description:parsed.description||f.description, partNumber:parsed.partNumber||f.partNumber, listPrice:parsed.listPrice||f.listPrice, weight:parsed.weight||f.weight, shippingOption:parsed.shippingOption||f.shippingOption, costs:parsed.sizeTier?COST_TIERS[parsed.sizeTier]||f.costs:f.costs, ai_assessed:true }))
    } catch(e) { setAiError(e.message) }
    setAnalysing(false)
  }

  const handleSave = () => onSave({ ...form, list_price:+form.listPrice||0, sold_price:form.soldPrice?+form.soldPrice:null })
  const handleSaveAndAdd = () => onSaveAndAdd({ ...form, list_price:+form.listPrice||0, sold_price:form.soldPrice?+form.soldPrice:null })

  return (
    <div style={{ maxWidth: 800 }}>
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

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h2 style={S.h1}>{part ? 'Edit Part' : 'Add Part'}</h2>
        <div style={{ display:'flex', gap:8 }}>
          <button style={S.btn('secondary')} onClick={onCancel}>Cancel</button>
          {!part && <button style={{ ...S.btn('secondary'), border:`1.5px solid ${C.blue}`, color:C.blue }} onClick={handleSaveAndAdd}>Save & Add Another</button>}
          <button style={S.btn()} onClick={handleSave}>Save Part</button>
        </div>
      </div>

      {/* AI Quick Add */}
      {!part && (
        <div style={{ ...S.card, background:'#f5f3ff', borderColor:'#c4b5fd', marginBottom:20 }}>
          <div style={{ fontWeight:700, fontSize:14, color:'#7c3aed', marginBottom:6 }}>✨ AI Quick Add</div>
          <div style={{ fontSize:12, color:C.muted, marginBottom:10 }}>Upload a photo and AI will fill in title, category, condition, description and pricing.</div>
          <input ref={photoRef} type="file" accept="image/*" multiple style={{ display:'none' }} onChange={handlePhoto} />
          {aiPhotos.length > 0 && (
            <div style={{ display:'flex', gap:8, marginBottom:10, flexWrap:'wrap' }}>
              {aiPhotos.map((p,i) => (
                <div key={i} style={{ position:'relative', width:64, height:64 }}>
                  <img src={p} style={{ width:64, height:64, borderRadius:6, objectFit:'cover' }} />
                  <button onClick={() => setAiPhotos(ps => ps.filter((_,j) => j!==i))} style={{ position:'absolute', top:-5, right:-5, background:C.red, border:'none', color:'#fff', borderRadius:'50%', width:18, height:18, fontSize:10, cursor:'pointer', padding:0, lineHeight:'18px' }}>×</button>
                </div>
              ))}
            </div>
          )}
          {aiError && <div style={{ fontSize:12, color:C.red, marginBottom:8 }}>{aiError}</div>}
          <div style={{ display:'flex', gap:8 }}>
            <button style={{ ...S.btn('secondary'), padding:'7px 14px', fontSize:12 }} onClick={() => photoRef.current.click()}>📷 {aiPhotos.length ? 'Change Photo' : 'Add Photo'}</button>
            <button style={{ ...S.btn(), background:'#7c3aed', padding:'7px 14px', fontSize:12, opacity:analysing||!aiPhotos.length?0.6:1 }} onClick={handleAIQuickAdd} disabled={analysing||!aiPhotos.length}>
              {analysing ? '⏳ Analysing...' : '✨ Analyse & Fill'}
            </button>
          </div>
        </div>
      )}

      {/* Link to Car */}
      {cars && cars.length > 0 && (
        <Field label="Link to Car">
          <select style={S.select} value={form.car_id||''} onChange={e => handleCarChange(e.target.value)}>
            <option value="">— No car linked —</option>
            {cars.map(c => <option key={c.id} value={c.id}>{c.make} {c.model} {c.year}</option>)}
          </select>
        </Field>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <Field label="SKU"><input style={S.input} value={form.sku||''} onChange={e => set('sku', e.target.value)} /></Field>
        <Field label="OEM Part Number"><input style={S.input} value={form.partNumber||''} onChange={e => set('partNumber', e.target.value)} /></Field>
      </div>
      <Field label={`Title (${(form.title||'').length}/80)`}>
        <input style={S.input} value={form.title||''} onChange={e => set('title', e.target.value)} />
      </Field>
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
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
        <Field label="Condition">
          <select style={S.select} value={form.condition||''} onChange={e => set('condition', e.target.value)}>
            {PART_CONDITIONS.map(c => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select style={S.select} value={form.status||'In Stock'} onChange={e => set('status', e.target.value)}>
            {['In Stock','Listed','Sold','Archived'].map(s => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Shipping">
          <select style={S.select} value={form.shippingOption||AU_SHIPPING[0]} onChange={e => set('shippingOption', e.target.value)}>
            {AU_SHIPPING.map(s => <option key={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      <div style={{ marginBottom:12 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
          <label style={{ ...S.label, margin:0 }}>Description</label>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:12, color:form.ai_assessed?C.green:C.muted }}>
              <input type="checkbox" checked={form.ai_assessed||false}
                onChange={e => { if (!e.target.checked && form.ai_assessed) setUncheckedWarning(true); else set('ai_assessed', e.target.checked) }}
                style={{ accentColor:C.green, width:14, height:14 }} />
              <span style={{ fontWeight:600 }}>AI Assessed {form.ai_assessed?'✓':''}</span>
            </label>
            <button style={{ ...S.btn('blue'), padding:'4px 12px', fontSize:12, opacity:generating?0.6:1 }} onClick={handleGenerateDesc} disabled={generating}>
              {generating ? '⏳ Generating...' : '✨ Generate'}
            </button>
          </div>
        </div>
        <textarea style={S.textarea} value={form.description||''} onChange={e => { set('description', e.target.value); if (e.target.value) set('ai_assessed', false) }} />
      </div>

      <div style={{ ...S.card, background:'#f9f8f5', marginBottom:20 }}>
        <h2 style={{ ...S.h2, marginBottom:16 }}>💸 Costs (AUD)</h2>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
          {Object.keys(form.costs||{}).map(k => (
            <Field key={k} label={`${k.charAt(0).toUpperCase()+k.slice(1)} ($)`}>
              <input style={S.input} type="number" min="0" step="0.01" value={form.costs[k]||0} onChange={e => setCost(k, e.target.value)} />
            </Field>
          ))}
        </div>
        <div style={{ display:'flex', gap:20, marginTop:8, fontSize:12 }}>
          <span>Cost: <strong style={{ color:C.red }}>{fmt(cost)}</strong></span>
          <span>Profit: <strong style={{ color:profit>=0?C.green:C.red }}>{fmt(profit)}</strong></span>
          <span>Margin: <strong style={{ color:margin>=30?C.green:C.yellow }}>{pct(margin)}</strong></span>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
        <Field label="List Price ($)"><input style={S.input} type="number" value={form.listPrice||''} onChange={e => set('listPrice', e.target.value)} /></Field>
        <Field label="Sold Price ($)"><input style={S.input} type="number" value={form.soldPrice||''} onChange={e => set('soldPrice', e.target.value)} /></Field>
        <Field label="Weight (kg)"><input style={S.input} type="number" value={form.weight||''} onChange={e => set('weight', e.target.value)} /></Field>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <Field label="Acquired Date"><input style={S.input} type="date" value={form.acquiredDate||''} onChange={e => set('acquiredDate', e.target.value)} /></Field>
        <Field label="Notes"><input style={S.input} value={form.notes||''} onChange={e => set('notes', e.target.value)} /></Field>
      </div>
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
        <button style={S.btn('secondary')} onClick={onCancel}>Cancel</button>
        {!part && <button style={{ ...S.btn('secondary'), border:`1.5px solid ${C.blue}`, color:C.blue }} onClick={handleSaveAndAdd}>Save & Add Another</button>}
        <button style={S.btn()} onClick={handleSave}>Save Part</button>
      </div>
    </div>
  )
}

// ─── Bulk AI Panel ─────────────────────────────────────────────────────────
function BulkAIPanel({ group, onComplete, aiSettings, footer }) {
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
        const desc = await generateAIDescription(part, aiSettings, footer)
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
export default function Inventory({ parts, cars, onAdd, onEdit, onDelete, onDeleteCar, onAddCar, storeId, aiSettings, footer }) {
  const [viewMode, setViewMode] = useState('parts')
  const [search, setSearch] = useState('')
  const [filterMake, setFilterMake] = useState('')
  const [filterModel, setFilterModel] = useState('')
  const [filterYear, setFilterYear] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterCond, setFilterCond] = useState('')
  const [showSold, setShowSold] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
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
    if (p.status==='Deleted'&&!showDeleted) return false
    if (!showSold&&p.status==='Sold') return false
    if (showDeleted&&p.status!=='Deleted') return false
    const q=search.toLowerCase()
    if (q&&![p.title,p.make,p.model,p.year,p.sku,p.partNumber,p.category,p.subcategory,p.condition,p.status].some(v=>(v||'').toLowerCase().includes(q))) return false
    if (filterMake&&p.make!==filterMake) return false
    if (filterModel&&p.model!==filterModel) return false
    if (filterYear&&!(p.year||'').includes(filterYear)) return false
    if (filterCat&&p.category!==filterCat) return false
    if (filterStatus&&p.status!==filterStatus) return false
    if (filterCond&&p.condition!==filterCond) return false
    return true
  }), [parts,search,filterMake,filterModel,filterYear,filterCat,filterStatus,filterCond,showSold,showDeleted])

  const carGroups = useMemo(() => {
    const g={}
    filtered.forEach(p => {
      const key=[p.make||'Unknown',p.model||'',p.year||'',p.car_id||p.session_id||''].join('|')
      if (!g[key]) g[key]={make:p.make||'Unknown',model:p.model||'',year:p.year||'',carId:p.car_id||null,sessionId:p.session_id||'',parts:[]}
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
    <PartForm part={editingPart} cars={cars} storeId={storeId} aiSettings={aiSettings} footer={footer}
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
          <button onClick={() => setShowSold(s=>!s)} style={{ ...S.btn(showSold?'green':'secondary'), padding:'5px 12px', fontSize:12 }}>{showSold?'✓ Sold Shown':'Show Sold'}</button>
          <button onClick={() => setShowDeleted(d=>!d)} style={{ ...S.btn(showDeleted?'danger':'secondary'), padding:'5px 12px', fontSize:12 }}>{showDeleted?'← Back':'🗑 Deleted'}</button>
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
            <option value="">All Statuses</option>{['In Stock','Listed','Sold','Archived'].map(s=><option key={s}>{s}</option>)}
          </select>
          <select style={{ ...selSm, minWidth:130 }} value={filterCond} onChange={e => { setFilterCond(e.target.value); setPage(0) }}>
            <option value="">All Conditions</option>{PART_CONDITIONS.map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {viewMode==='car' && (
        <div>
          <div style={{ display:'flex', gap:8, marginBottom:10, alignItems:'center' }}>
            <span style={{ fontSize:13, color:C.muted }}>{carGroups.length} car{carGroups.length!==1?'s':''}</span>
            <button onClick={() => setExpandedCars(new Set(carGroups.map(g=>g.make+'|'+g.model+'|'+g.year+'|'+(g.carId||g.sessionId))))} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11 }}>Expand All</button>
            <button onClick={() => setExpandedCars(new Set())} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11 }}>Collapse All</button>
          </div>
          {bulkAIGroup && <BulkAIPanel group={bulkAIGroup} aiSettings={aiSettings} footer={footer} onComplete={() => setBulkAIGroup(null)} />}
          {carGroups.map(g => {
            const key=g.make+'|'+g.model+'|'+g.year+'|'+(g.carId||g.sessionId)
            const isOpen=expandedCars.has(key)
            const gList=g.parts.reduce((a,p)=>a+(+p.list_price||0),0)
            const gCost=g.parts.reduce((a,p)=>a+totalCost(p),0)
            const gProfit=gList-gCost
            const gStock=g.parts.filter(p=>p.status==='In Stock').length
            const gListed=g.parts.filter(p=>p.status==='Listed').length
            const gSold=g.parts.filter(p=>p.status==='Sold').length
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
                              <td style={{ padding:'8px 12px' }}><span style={{ ...S.pill(stCol), fontSize:11 }}>{p.status}</span></td>
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
                  const bg=p.status==='Deleted'?'#fff5f5':p.status==='Sold'?'#f0fdf4':i%2===0?'#ffffff':'#faf9f7'
                  const td=(v,col,bold)=><td style={{ padding:'4px 8px', fontSize:12, color:col||C.text, fontWeight:bold?700:400, borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}`, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', maxWidth:260 }} title={String(v||'')}>{v||<span style={{color:C.border}}>—</span>}</td>
                  return (
                    <tr key={p.id} style={{ background:bg }}>
                      <td style={{ padding:'4px 6px', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}` }}>
                        <button onClick={()=>{setEditingPart(p);setShowForm(true)}} style={{ fontSize:11, padding:'2px 8px', background:'#eff6ff', color:C.blue, border:`1px solid ${C.blue}44`, borderRadius:4, cursor:'pointer' }}>Edit</button>
                      </td>
                      {td(p.sku)}{td(p.title)}{td(p.make)}{td(p.model)}{td(p.year)}{td(p.subcategory||p.category)}
                      <td style={{ padding:'4px 8px', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}` }}>
                        <span style={{ ...S.pill(stCol), fontSize:10, padding:'1px 6px' }}>{p.status}</span>
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
