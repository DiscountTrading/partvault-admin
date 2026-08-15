import { useState, useMemo, useRef, useEffect } from 'react'
import { C, S, fmt, pct, totalCost, partEffectiveCost, estimateCostBasis, CATEGORY_NAMES, EBAY_AU_CATEGORIES, canonicalCategory, canonicalSubcategory, PART_CONDITIONS, STATUS_COLORS, STATUS_LABELS } from '../lib/constants'
import { sb, EDGE_FN } from '../lib/supabase'
import { getActiveMarketplace, formatWeight } from '../lib/marketplaces'
import { makesFor, MODEL_SUGS } from '../lib/vehicles'
import { printLabels, DEFAULT_LABELS } from '../lib/labels'
import { WAREHOUSE_DEFAULTS, warehouseConfig } from '../lib/warehouse'
import BulkEdit from './BulkEdit'
import ListingPreview from './ListingPreview'
import EbayActions from './EbayActions'
import useFillHeight from '../hooks/useFillHeight'

import { Field, EbayLogo, EBAY_BLUE, Section, AutoInput, descPromptCore, learnCtx, urlFrom, partHasPhoto, compressImg, defCosts, COST_TIERS, WeightField, ebayItmUrl, generateAIDescription, generateDescriptionOptions, regenerateDescriptionOptions, analysePart } from './inventoryShared'

// The full-screen part editor — extracted verbatim from Inventory.jsx
// (refactor 3/5). Mounted by Inventory for both add and edit.
function PartForm({ part, cars, storeId, onSave, onSaveAndAdd, onCancel, aiSettings, footer, costing, labels = DEFAULT_LABELS, warehouse = WAREHOUSE_DEFAULTS, allParts = [] }) {
  const defCat = CATEGORY_NAMES[4]
  const curSym = getActiveMarketplace().currencySymbol
  const usesOz = getActiveMarketplace().weightUnit === 'oz'
  const [form, setForm] = useState(part ? { ...part, costs: { ...part.costs }, listPrice: part.list_price||part.listPrice||0, ai_assessed: part.ai_assessed??false, acquiredDate: part.acquiredDate ? String(part.acquiredDate).slice(0,10) : (part.createdAt ? String(part.createdAt).slice(0,10) : '') } : {
    title:'', category:defCat, subcategory:EBAY_AU_CATEGORIES[defCat][0], make:'', model:'', year:'', condition:PART_CONDITIONS[1],
    description:'', acquiredDate:new Date().toISOString().slice(0,10), costs:defCosts(), listPrice:'', soldPrice:'', photos:[], weight:'', status:'in_stock',
    partNumber:'', notes:'', location:'', locRow:'', locBay:'', locShelf:'', containerId:'', ai_assessed:false, car_id:null,
  })
  const [generating, setGenerating] = useState(false)
  const [containers, setContainers] = useState([])     // store's tubs/buckets (when enabled)
  useEffect(() => {
    if (!warehouse?.containers || !storeId) return
    sb.from('containers').select('id, code, name, loc_row, loc_bay, loc_shelf')
      .eq('store_id', storeId).is('deleted_at', null).order('code')
      .then(({ data }) => setContainers(data || []))
  }, [warehouse?.containers, storeId])
  const [descOptions, setDescOptions] = useState([])   // ranked description choices
  const [descPicker, setDescPicker] = useState(false)  // options panel open
  const [descBusy, setDescBusy] = useState(false)
  const [mineText, setMineText] = useState('')         // "write my own" text
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
  // eBay category override picker (fix a wrong AI/taxonomy category + teach it)
  const [catEditing, setCatEditing] = useState(false)
  const [catQuery, setCatQuery] = useState('')
  const [catSugs, setCatSugs] = useState([])
  const [catSearching, setCatSearching] = useState(false)
  const [catSaving, setCatSaving] = useState(false)
  const [market, setMarket] = useState(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketErr, setMarketErr] = useState('')
  const photoRef = useRef()

  // Real eBay market data (Browse comps + Catalog match) for this part.
  const loadMarket = async () => {
    setMarketLoading(true); setMarketErr('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'market_lookup', storeId, partId: part?.id, part: { title: form.title, make: form.make, model: form.model, year: form.year, part_number: form.partNumber, list_price: +form.listPrice || 0, category: form.category } }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Market lookup failed')
      setMarket(d)
      // Stamp the form so the "last checked" line reflects this refresh immediately.
      if (d.browse && !d.browse.error && d.browse.median > 0) setForm(f => ({ ...f, marketPrice: d.browse.median, marketCheckedAt: new Date().toISOString() }))
    } catch (e) { setMarketErr(e.message) }
    setMarketLoading(false)
  }

  // Read-only preview of the exact eBay category + item specifics + fitment that
  // a publish would send, generated from the part's photos (one AI call).
  const hydratePreview = (d) => {
    setPreview(d)
    const base = {}; (d.specifics || []).forEach(s => { base[s.name] = s.value || '' })
    setSpecBaseline(base); setSpecEdits(base)
    const fit = (d.fitment || []).map(f => ({ make:f.make||'', model:f.model||'', yearFrom:f.yearFrom||'', yearTo:f.yearTo||'', trim:f.trim||'' }))
    setFitEdits(fit); setFitBaseline(JSON.stringify(fit))
    setPreviewSig(previewInputSig())
  }
  const loadPreview = async ({ force = false } = {}) => {
    if (!part?.id) return
    // Instant hydrate from the background-generated snapshot when it still matches
    // the current inputs — no AI call, and it's already listing-ready.
    const cached = part?.ebaySpecifics
    if (!force && cached && cached.sig === previewInputSig()) { hydratePreview(cached); return }
    setPreviewLoading(true); setPreviewErr('')
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'preview_listing', storeId, partId: part.id, title: form.title, price: +form.listPrice || 0, condition: form.condition, description: form.description || '' }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Preview failed')
      hydratePreview(d)
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
  // eBay category correction: search the live tree, apply an override for this
  // part, and (server-side) learn it for future parts of the same type.
  const EBAY_FN = EDGE_FN
  const callEbay = async (payload) => {
    const { data: { session } } = await sb.auth.getSession()
    const res = await fetch(EBAY_FN, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${session?.access_token}` }, body: JSON.stringify(payload) })
    const d = await res.json()
    if (!res.ok || d.error) throw new Error(d.error || 'Request failed')
    return d
  }
  const openCatEditor = () => { setCatEditing(true); setCatSugs([]); setCatQuery(form.title || `${form.make||''} ${form.subcategory||form.category||''}`.trim()) }
  const searchCats = async () => {
    const q = catQuery.trim(); if (!q) return
    setCatSearching(true); setPreviewErr('')
    try { const d = await callEbay({ action:'category_suggestions', storeId, query:q }); setCatSugs(d.suggestions || []) }
    catch (e) { setPreviewErr(e.message) }
    setCatSearching(false)
  }
  const applyCat = async (sug) => {
    setCatSaving(true); setPreviewErr('')
    try {
      const d = await callEbay({ action:'set_category', storeId, partId: part.id, categoryId: sug.id, categoryName: sug.name })
      setForm(f => ({ ...f, ebayOverrides: d.ebay_overrides }))
      setCatEditing(false); setCatSugs([]); setCatQuery('')
      await loadPreview()
    } catch (e) { setPreviewErr(e.message) }
    setCatSaving(false)
  }
  const resetCat = async () => {
    setCatSaving(true); setPreviewErr('')
    try {
      const d = await callEbay({ action:'set_category', storeId, partId: part.id, categoryId:'', categoryName:'' })
      setForm(f => ({ ...f, ebayOverrides: d.ebay_overrides }))
      setCatEditing(false)
      await loadPreview()
    } catch (e) { setPreviewErr(e.message) }
    setCatSaving(false)
  }
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setCost = (k, v) => setForm(f => ({ ...f, costs: { ...f.costs, [k]: +v||0 } }))

  // Flag that a part editor is open, so switching stores can warn before leaving.
  useEffect(() => { window.__pvPartOpen = true; return () => { window.__pvPartOpen = false } }, [])
  const manualCost = Object.values(form.costs||{}).reduce((a,v) => a+(+v||0), 0)
  // Estimated cost basis from the store costing config (car-cost share + removal
  // labour + admin). carPartsValue = sum of list prices of this car's parts.
  const formCar = cars?.find(c => c.id === form.car_id)
  const carPartsValue = (allParts||[]).filter(p => p.car_id === form.car_id && !p.deletedAt)
    .reduce((a,p) => a + (p.id === form.id ? (+form.listPrice||0) : (+p.list_price||+p.listPrice||0)), 0)
  const basis = estimateCostBasis({ list_price: +form.listPrice||0, removalMinutes: form.removalMinutes, weight: form.weight, costs: form.costs }, costing, +formCar?.purchase_price||0, carPartsValue)
  // basis.postage is the actual recorded carrier cost when present (already inside
  // manualCost) or a weight-based estimate when not. Only add it to the total when
  // it's the estimate, so a manually-entered postage isn't counted twice.
  const extraPostage = basis.postageEstimated ? basis.postage : 0
  const cost = manualCost + basis.carShare + basis.baseCost + basis.labour + basis.admin + extraPostage
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

  // Fetch several ranked options to choose from.
  const handleDescOptions = async () => {
    setDescBusy(true); setAiError(''); setDescPicker(true); setDescOptions([])
    try { setDescOptions(await generateDescriptionOptions(form, aiSettings, storeId, 5)) }
    catch(e) { setAiError(e.message); setDescPicker(false) }
    setDescBusy(false)
  }

  // Turn the seller's own text into 4 variants + keep their verbatim as an option.
  const handleRegenerateMine = async () => {
    const mine = mineText.trim()
    if (!mine) return
    setDescBusy(true); setAiError('')
    try { setDescOptions([...(await regenerateDescriptionOptions(mine, form, aiSettings, storeId)), mine]) }
    catch(e) { setAiError(e.message) }
    setDescBusy(false)
  }

  const chooseDesc = (text) => { set('description', text); set('ai_assessed', true); setDescPicker(false); setMineText('') }

  const handleAIQuickAdd = async () => {
    if (!aiPhotos.length) { setAiError('Add at least one photo for AI analysis'); return }
    setAnalysing(true); setAiError('')
    try {
      const car = cars?.find(c => c.id === form.car_id)
      const parsed = await analysePart({ photoBase64s: aiPhotos.map(p => p.split(',')[1]), carId: car?.id }, car||form, storeId)
      setForm(f => ({ ...f, title:parsed.title||f.title, category:parsed.category||f.category, subcategory:parsed.subcategory||f.subcategory, condition:parsed.condition||f.condition, description:parsed.description||f.description, partNumber:parsed.partNumber||f.partNumber, listPrice:parsed._learnedPrice||parsed.listPrice||f.listPrice, weight:parsed.weight||f.weight, removalMinutes:parsed.removalMinutes??f.removalMinutes, costs:parsed.sizeTier?COST_TIERS[parsed.sizeTier]||f.costs:f.costs, ai_assessed:true }))
      if (parsed._learnedPrice) setAiError('')
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
      setForm(f => ({ ...f, title:parsed.title||f.title, category:parsed.category||f.category, subcategory:parsed.subcategory||f.subcategory, condition:parsed.condition||f.condition, description:parsed.description||f.description, partNumber:parsed.partNumber||f.partNumber, listPrice:parsed._learnedPrice||parsed.listPrice||f.listPrice, weight:parsed.weight||f.weight, removalMinutes:parsed.removalMinutes??f.removalMinutes, costs:parsed.sizeTier?COST_TIERS[parsed.sizeTier]||f.costs:f.costs, ai_assessed:true }))
    } catch(e) { setAiError(e.message) }
    setAnalysing(false)
  }

  // Canonicalise category/subcategory on save so a stored punctuation variant
  // becomes the exact key (fixes the value everywhere it's matched).
  const normForm = () => {
    const category = canonicalCategory(form.category) || form.category
    return { ...form, category, subcategory: canonicalSubcategory(category, form.subcategory), list_price:+form.listPrice||0, sold_price:form.soldPrice?+form.soldPrice:null }
  }
  const handleSave = () => onSave(normForm())
  const handleSaveAndAdd = () => onSaveAndAdd(normForm())

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
                <span style={{ color:C.muted }}>Ship: {formatWeight(preview.weightG||0)} · {preview.dims?.l}×{preview.dims?.w}×{preview.dims?.h}cm</span>
              </div>
              <div style={{ fontSize:13, marginBottom:12 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  <span style={{ color:C.muted }}>eBay category: </span>
                  <strong style={{ color:C.text }}>{preview.categoryName || preview.categoryId}</strong>
                  {preview.categorySource === 'override' && <span title="You set this" style={{ fontSize:11, color:'#1d4ed8', background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:6, padding:'1px 6px' }}>your choice</span>}
                  {preview.categorySource === 'learned' && <span title="Learned from a previous correction" style={{ fontSize:11, color:'#7c3aed', background:'#f5f3ff', border:'1px solid #ddd6fe', borderRadius:6, padding:'1px 6px' }}>learned</span>}
                  {!catEditing && <button onClick={openCatEditor} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:12 }}>Change</button>}
                  {!catEditing && preview.categorySource === 'override' && <button onClick={resetCat} disabled={catSaving} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:12, opacity:catSaving?0.5:1 }}>Reset to AI</button>}
                </div>
                {catEditing && (
                  <div style={{ marginTop:8, padding:10, background:'#f9f8f5', border:`1px solid ${C.border}`, borderRadius:8 }}>
                    <div style={{ display:'flex', gap:6, marginBottom:8 }}>
                      <input value={catQuery} onChange={e=>setCatQuery(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'){ e.preventDefault(); searchCats() } }}
                        placeholder="Search eBay categories, e.g. ABS pump" style={{ ...S.input, flex:1, marginBottom:0, fontSize:13 }} autoFocus />
                      <button onClick={searchCats} disabled={catSearching||!catQuery.trim()} style={{ ...S.btn('primary'), padding:'6px 14px', fontSize:12, opacity:(catSearching||!catQuery.trim())?0.5:1 }}>{catSearching?'…':'Search'}</button>
                      <button onClick={()=>{ setCatEditing(false); setCatSugs([]) }} style={{ ...S.btn('secondary'), padding:'6px 12px', fontSize:12 }}>Cancel</button>
                    </div>
                    {catSugs.length > 0 && (
                      <div style={{ border:`1px solid ${C.border}`, borderRadius:8, overflow:'hidden', background:'#fff', maxHeight:260, overflowY:'auto' }}>
                        {catSugs.map((s,i) => (
                          <button key={s.id} onClick={()=>applyCat(s)} disabled={catSaving}
                            style={{ display:'block', width:'100%', textAlign:'left', fontSize:12, padding:'7px 10px', background:i%2?'#fafafa':'#fff', border:'none', borderBottom:i<catSugs.length-1?`1px solid ${C.border}`:'none', cursor:'pointer', color:C.text, opacity:catSaving?0.5:1 }}>
                            {s.name} <span style={{ color:C.muted }}>· {s.id}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {catSearching && <div style={{ fontSize:12, color:C.muted }}>Searching eBay…</div>}
                    {!catSearching && catSugs.length === 0 && <div style={{ fontSize:11, color:C.muted }}>Type what the part is and press Search. Picking a category fixes this part and teaches PartVault for similar parts.</div>}
                  </div>
                )}
              </div>
              {preview.conditionDescription && (
                <div style={{ fontSize:12, marginBottom:12, padding:'8px 10px', background:'#f9f8f5', border:`1px solid ${C.border}`, borderRadius:8 }}>
                  <span style={{ color:C.muted, fontWeight:700 }}>Condition description: </span>
                  <span style={{ color:C.text }}>{preview.conditionDescription}</span>
                </div>
              )}
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
        {(() => {
          // Resolve stored values to canonical keys so the subcategory list always
          // renders (and the current value is never dropped from the dropdown).
          const catVal = canonicalCategory(form.category) || defCat
          const catList = CATEGORY_NAMES.includes(catVal) ? CATEGORY_NAMES : [catVal, ...CATEGORY_NAMES]
          const subOpts = EBAY_AU_CATEGORIES[catVal] || []
          const subVal = canonicalSubcategory(catVal, form.subcategory)
          const subList = subVal && !subOpts.includes(subVal) ? [subVal, ...subOpts] : subOpts
          return (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="Category">
            <select style={S.select} value={catVal} onChange={e => { set('category', e.target.value); set('subcategory', EBAY_AU_CATEGORIES[e.target.value]?.[0]||'') }}>
              {catList.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Subcategory">
            <select style={S.select} value={subVal} onChange={e => set('subcategory', e.target.value)}>
              {subList.length === 0 && <option value="">—</option>}
              {subList.map(s => <option key={s}>{s}</option>)}
            </select>
          </Field>
        </div>
          )
        })()}
      </Section>

      {/* Item specifics — vehicle fitment */}
      <Section title="Item specifics" hint="Compatibility buyers filter on.">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
          <Field label="Make">
            <select style={S.select} value={form.make||''} onChange={e => { set('make', e.target.value); set('model', '') }}>
              <option value="">Select Make</option>
              {makesFor().map(m => <option key={m}>{m}</option>)}
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
            <button style={{ ...S.btn(), padding:'5px 14px', fontSize:12, borderRadius:20, opacity:descBusy?0.6:1 }} onClick={handleDescOptions} disabled={descBusy || generating}>
              {descBusy ? '⏳ …' : '✨ Options'}
            </button>
            <button style={{ ...S.btn('blue'), padding:'5px 14px', fontSize:12, borderRadius:20, opacity:generating?0.6:1 }} onClick={handleGenerateDesc} disabled={generating || descBusy}>
              {generating ? '⏳ Generating…' : '✨ Generate'}
            </button>
          </div>
        }>
        <textarea style={{ ...S.textarea, minHeight:140 }} value={form.description||''} onChange={e => { set('description', e.target.value); if (e.target.value) set('ai_assessed', false) }} placeholder="Describe condition, fitment and any defects…" />

        {/* Ranked description options — pick one, or write your own and regenerate */}
        {descPicker && (
          <div style={{ marginTop:10, padding:'12px 14px', background:'#f7f5ff', border:`1px solid #ddd6fe`, borderRadius:10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <span style={{ fontSize:12, fontWeight:700, color:C.text }}>{descBusy ? 'Generating options…' : `Pick a description (${descOptions.length})`}</span>
              <button style={{ background:'none', border:'none', color:C.muted, fontSize:12, cursor:'pointer' }} onClick={() => setDescPicker(false)}>Close ✕</button>
            </div>
            {descBusy && !descOptions.length && <div style={{ fontSize:12, color:C.muted }}>⏳ Writing options…</div>}
            {descOptions.map((opt, i) => (
              <div key={i} onClick={() => chooseDesc(opt)}
                style={{ cursor:'pointer', background:'#fff', border:`1px solid ${form.description===opt?C.accent:C.border}`, borderRadius:8, padding:'10px 12px', marginBottom:8, fontSize:13, lineHeight:1.5, color:C.text }}>
                <div style={{ fontWeight:700, fontSize:11, color:C.accent, marginBottom:4 }}>{i+1}{i===0?' · best match':''} — click to use</div>
                {opt}
              </div>
            ))}
            {/* Write my own → regenerate */}
            <div style={{ marginTop:6, paddingTop:10, borderTop:`1px dashed ${C.border}` }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.text, marginBottom:6 }}>✏️ Write your own — AI will refine it into new options</div>
              <textarea value={mineText} onChange={e => setMineText(e.target.value)} placeholder="Type your description…"
                style={{ ...S.textarea, minHeight:70, fontSize:13 }} />
              <div style={{ display:'flex', gap:8, marginTop:6 }}>
                <button style={{ ...S.btn('blue'), padding:'6px 14px', fontSize:12, borderRadius:20, opacity:(descBusy||!mineText.trim())?0.6:1 }} onClick={handleRegenerateMine} disabled={descBusy || !mineText.trim()}>✨ Regenerate from mine</button>
                <button style={{ ...S.btn(), padding:'6px 14px', fontSize:12, borderRadius:20 }} onClick={() => chooseDesc(mineText.trim())} disabled={!mineText.trim()}>Use mine as-is</button>
              </div>
            </div>
          </div>
        )}
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
          <Field label={`List Price (${curSym})`}><input style={{ ...S.input, fontWeight:700, fontSize:16 }} type="number" value={form.listPrice||''} onChange={e => set('listPrice', e.target.value)} /></Field>
          <Field label={`Sold Price (${curSym})`}><input style={S.input} type="number" value={form.soldPrice||''} onChange={e => set('soldPrice', e.target.value)} /></Field>
          <Field label={`Shipping charged (${curSym})`}><input style={S.input} type="number" value={form.shippingCharged||''} onChange={e => set('shippingCharged', e.target.value)} /></Field>
          <Field label={usesOz ? 'Weight (lb / oz)' : 'Weight (g)'}><WeightField grams={form.weight} onChange={v => set('weight', v)} /></Field>
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
              {basis.carShare > 0 && <span>Car share: <strong style={{ color:C.text }}>{fmt(basis.carShare)}</strong></span>}
              {basis.baseCost > 0 && <span>Base cost (est.): <strong style={{ color:C.text }}>{fmt(basis.baseCost)}</strong></span>}
              <span>Removal labour: <strong style={{ color:C.text }}>{fmt(basis.labour)}</strong></span>
              <span>Admin: <strong style={{ color:C.text }}>{fmt(basis.admin)}</strong></span>
              <span>Postage{basis.postageEstimated ? ' (est.)' : ''}: <strong style={{ color:C.text }}>{fmt(basis.postage)}</strong></span>
              <span>Auto basis: <strong style={{ color:C.text }}>{fmt(basis.carShare + basis.baseCost + basis.labour + basis.admin + extraPostage)}</strong></span>
            </div>
          </div>
          <div style={{ display:'flex', gap:20, marginTop:12, fontSize:12 }}>
            <span>Total cost: <strong style={{ color:C.red }}>{fmt(cost)}</strong></span>
            <span>Profit: <strong style={{ color:profit>=0?C.green:C.red }}>{fmt(profit)}</strong></span>
            <span>Margin: <strong style={{ color:margin>=30?C.green:C.yellow }}>{pct(margin)}</strong></span>
          </div>
        </div>

        {/* Live eBay market data — what similar used parts are listed at right now */}
        <div style={{ marginTop:14, padding:'12px 14px', background:'#fff', border:`1px solid ${C.border}`, borderRadius:10 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:C.text }}>📊 eBay market price</div>
              {(() => {
                if (!form.marketCheckedAt) return <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>Not checked yet</div>
                const days = Math.floor((Date.now() - new Date(form.marketCheckedAt).getTime()) / 86400000)
                const color = days > 21 ? C.red : days > 10 ? C.yellow : C.muted
                return <div style={{ fontSize:11, color, marginTop:2 }}>Last checked {days <= 0 ? 'today' : `${days}d ago`}{form.marketPrice ? ` · median ${fmt(form.marketPrice)}` : ''}{days > 10 ? ' — refresh before adjusting' : ''}</div>
              })()}
            </div>
            <button onClick={loadMarket} disabled={marketLoading} style={{ ...S.btn(form.marketCheckedAt && (Date.now()-new Date(form.marketCheckedAt).getTime())/86400000 > 10 ? 'primary' : 'secondary'), padding:'5px 14px', fontSize:12, opacity:marketLoading?0.6:1 }}>
              {marketLoading ? 'Checking…' : form.marketCheckedAt ? 'Refresh' : 'Check market'}
            </button>
          </div>
          {marketErr && <div style={{ fontSize:12, color:C.red, marginTop:8 }}>{marketErr}</div>}
          {market?.browse && !market.browse.error && (
            <div style={{ marginTop:10, fontSize:13 }}>
              <div style={{ fontSize:12, color:C.muted, marginBottom:6 }}>Matched by {market.matchedBy} · {market.browse.total} active used listings · {market.browse.sampled} priced</div>
              <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginBottom:8 }}>
                <span>Range: <strong>{fmt(market.browse.min)}–{fmt(market.browse.max)}</strong></span>
                <span>Median: <strong style={{ color:C.text }}>{fmt(market.browse.median)}</strong></span>
                {market.browse.cheaperThanPct != null && <span style={{ color: market.browse.cheaperThanPct>=50?C.green:C.yellow }}>Your price beats {market.browse.cheaperThanPct}% of them</span>}
              </div>
              {/* Actionable pricing — how you sit vs the median + one-click apply */}
              {(() => {
                const med = Math.round(+market.browse.median || 0)
                if (med <= 0) return null
                const mine = +form.listPrice || 0
                const delta = mine > 0 ? Math.round(mine - med) : null
                return (
                  <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', marginBottom:8, padding:'8px 10px', background:C.panel, borderRadius:8 }}>
                    {delta == null ? <span style={{ fontSize:12, color:C.muted }}>Set a price to compare with the median.</span>
                      : Math.abs(delta) < 1 ? <span style={{ fontSize:12, color:C.green, fontWeight:700 }}>✓ You're right on the median</span>
                      : <span style={{ fontSize:12, fontWeight:700, color: delta > 0 ? C.yellow : C.green }}>You're {fmt(Math.abs(delta))} {delta > 0 ? 'above' : 'below'} the median</span>}
                    <div style={{ flex:1 }} />
                    {(() => {
                      const under = Math.max(1, Math.round(med * 0.95))
                      return <>
                        <button type="button" onClick={() => set('listPrice', med)} disabled={mine === med}
                          style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12, opacity: mine === med ? 0.5 : 1, cursor: mine === med ? 'default' : 'pointer' }}>
                          Match median {fmt(med)}
                        </button>
                        <button type="button" onClick={() => set('listPrice', under)} disabled={mine === under} title="Undercut the median by 5% to sell faster"
                          style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12, opacity: mine === under ? 0.5 : 1, cursor: mine === under ? 'default' : 'pointer' }}>
                          Undercut 5% {fmt(under)}
                        </button>
                      </>
                    })()}
                  </div>
                )
              })()}
              {!!market.browse.samples?.length && (
                <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                  {market.browse.samples.map((s,i) => (
                    <a key={i} href={s.url} target="_blank" rel="noopener" style={{ fontSize:12, color:C.muted, textDecoration:'none', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      <strong style={{ color:C.text }}>{fmt(s.price)}</strong> · {s.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
          {market?.browse?.error && <div style={{ fontSize:12, color:C.muted, marginTop:8 }}>No market data returned ({market.browse.error}).</div>}
          {market?.catalog && <div style={{ fontSize:12, color:C.muted, marginTop:8 }}>eBay catalog match: {market.catalog.title}{market.catalog.epid?` (ePID ${market.catalog.epid})`:''}</div>}
        </div>
      </Section>

      {/* Record keeping */}
      <Section title="Record keeping">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="Acquired Date"><input style={S.input} type="date" value={form.acquiredDate||''} onChange={e => set('acquiredDate', e.target.value)} /></Field>
          <Field label="Storage location"><input style={S.input} value={form.location||''} onChange={e => set('location', e.target.value)} placeholder="Shelf / bin / rack…" /></Field>
        </div>
        {warehouse?.enabled && (() => {
          const wc = warehouseConfig(warehouse)
          const axis = (key, label, count) => (
            <Field label={label}>
              <select style={S.select} value={form[key] ?? ''} onChange={e => set(key, e.target.value === '' ? '' : +e.target.value)}>
                <option value="">—</option>
                {Array.from({ length: Math.max(0, count | 0) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
              </select>
            </Field>
          )
          return (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginTop:12 }}>
              {axis('locRow', wc.rowLabel, wc.rows)}
              {axis('locBay', wc.bayLabel, wc.bays)}
              {axis('locShelf', wc.shelfLabel, wc.shelves)}
            </div>
          )
        })()}
        {warehouse?.containers && (
          <Field label={`${warehouseConfig(warehouse).containerLabel} (tub / bucket)`}>
            <select style={S.select} value={form.containerId || ''} onChange={e => {
              const id = e.target.value || null
              const ct = containers.find(c => c.id === id)
              // Inherit the container's home spot onto the part so the map/badges match.
              set('containerId', id)
              if (ct && (ct.loc_row != null || ct.loc_bay != null || ct.loc_shelf != null)) {
                setForm(f => ({ ...f, containerId: id, locRow: ct.loc_row ?? '', locBay: ct.loc_bay ?? '', locShelf: ct.loc_shelf ?? '' }))
              }
            }}>
              <option value="">— none (loose) —</option>
              {containers.map(c => <option key={c.id} value={c.id}>{[c.code, c.name].filter(Boolean).join(' · ')}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes"><input style={S.input} value={form.notes||''} onChange={e => set('notes', e.target.value)} /></Field>
      </Section>

      {/* eBay-style sticky action bar */}
      <div style={{ position:'sticky', bottom:0, marginTop:8, marginLeft:-2, marginRight:-2, background:'rgba(255,255,255,0.92)', backdropFilter:'blur(6px)', borderTop:`1px solid ${C.border}`, padding:'14px 4px', display:'flex', gap:12, justifyContent:'flex-end', alignItems:'center' }}>
        <span style={{ fontSize:12, color:C.muted, marginRight:'auto' }}>Saved as draft — not published to eBay until you list it.</span>
        <button style={ebayBtn('secondary')} onClick={onCancel}>Cancel</button>
        {part && form.sku && <button style={ebayBtn('secondary')} title="Print a stock label for this part" onClick={() => printLabels({ id: part.id, sku: form.sku, title: form.title, make: form.make, model: form.model, year: form.year, listPrice: form.listPrice }, labels)}>🏷️ Label</button>}
        {part?.status === 'listed' && part?.ebayItemId && !part?.isSample && <a href={ebayItmUrl(part.ebayItemId)} target="_blank" rel="noreferrer" style={{ ...ebayBtn('secondary'), textDecoration:'none', display:'inline-flex', alignItems:'center' }} title="Open this listing on eBay">🔗 View on eBay ↗</a>}
        {!part && <button style={ebayBtn('secondary')} onClick={handleSaveAndAdd}>Save & add another</button>}
        <button style={ebayBtn('primary')} onClick={handleSave}>{part ? 'Save changes' : 'Save draft'}</button>
      </div>
    </div>
  )
}

// ─── Bulk AI Panel ─────────────────────────────────────────────────────────

export default PartForm
