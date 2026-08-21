import { useState, useMemo, useEffect } from 'react'
import { C, S, totalCost, partEffectiveCost, CATEGORY_NAMES, canonicalCategory, PART_CONDITIONS, STATUS_LABELS } from '../lib/constants'
import { printLabels, DEFAULT_LABELS } from '../lib/labels'
import { WAREHOUSE_DEFAULTS } from '../lib/warehouse'
import BulkEdit from './BulkEdit'
import ListingPreview from './ListingPreview'
import EbayActions from './EbayActions'
import useFillHeight from '../hooks/useFillHeight'

import { EbayLink, StatusPill, EditableTd, BYPART_COLS, BYPART_MINW, partHasPhoto, AddCarModal, EBAY_BLUE } from './inventoryShared'
import PartForm from './PartForm'
import BulkAIPanel from './BulkAIPanel'

export default function Inventory({ parts, cars, onAdd, onEdit, onDelete, onDeleteCar, onAddCar, storeId, aiSettings, footer, costing, labels = DEFAULT_LABELS, warehouse = WAREHOUSE_DEFAULTS, refetch, assess, sampleActive = false }) {
  const [viewMode, setViewMode] = useState('parts')
  const [tableRef, tableH] = useFillHeight(28)  // By-Part grid fills to the viewport bottom
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
  const [showFilters, setShowFilters] = useState(false) // collapse the advanced filter row to save space
  const [showForm, setShowForm] = useState(false)
  const [editingPart, setEditingPart] = useState(null)
  // Switching stores must close any open part editor — the part belongs to the
  // previous store; leaving it open mixes the two stores.
  useEffect(() => { setShowForm(false); setEditingPart(null) }, [storeId])
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteCarTarget, setDeleteCarTarget] = useState(null)
  const [expandedCars, setExpandedCars] = useState(new Set())
  // eBay listing consolidation: row selection + a preview modal + a quick
  // "eBay mode" that filters to parts to list (in-stock) or de-list (listed).
  const [sel, setSel] = useState(() => new Set())
  const [previewPart, setPreviewPart] = useState(null)
  // The listing preview talks to eBay, which needs a connected account and a real
  // listing — a sample part has neither, so explain instead of "token not found".
  const openPreview = p => p.isSample
    ? alert('This is a sample part — there\'s no real eBay listing behind it, so there\'s nothing to preview.\n\nConnect your eBay store (Settings → eBay) and import your own listings to use this.')
    : setPreviewPart(p)
  const [ebayMode, setEbayMode] = useState('off') // off | list | delist
  useEffect(() => { setSel(new Set()) }, [storeId, ebayMode])
  const toggleSel = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [bulkAIGroup, setBulkAIGroup] = useState(null)
  const [showAddCar, setShowAddCar] = useState(false)
  const [page, setPage] = useState(0)
  const [PAGE, setPAGE] = useState(() => { try { return +localStorage.getItem('pv_inv_pagesize') || 100 } catch { return 100 } })
  const setPageSize = (n) => { setPAGE(n); setPage(0); try { localStorage.setItem('pv_inv_pagesize', String(n)) } catch { /* ignore */ } }
  const [carPage, setCarPage] = useState(0)
  const [carPageSize, setCarPageSize] = useState(25)

  // Background AI assessment now runs app-wide (useAssessQueue in App.jsx) so it
  // continues on any tab, not just while Inventory is open. We read its state here
  // for the richer in-page banner below.
  const { running: assessRunning = false, done: assessDone = 0, total: assessTotal = 0, paused: assessPaused = false, togglePaused: toggleAssessPaused = () => {}, remaining: assessRemaining = 0, etaMs: assessEta = null, retrySec: assessRetry = null, blocked: assessBlocked = null } = assess || {}
  const assessEtaTxt = assessEta && assessEta > 0 ? (assessEta < 60000 ? `~${Math.round(assessEta/1000)}s left` : `~${Math.round(assessEta/60000)} min left`) : ''

  const makes = useMemo(() => [...new Set(parts.filter(p=>p.make).map(p=>p.make))].sort(), [parts])
  const models = useMemo(() => { const src=filterMake?parts.filter(p=>p.make===filterMake):parts; return [...new Set(src.filter(p=>p.model).map(p=>p.model))].sort() }, [parts, filterMake])

  const filtered = useMemo(() => parts.filter(p => {
    if (ebayMode === 'list' && p.status !== 'in_stock') return false
    if (ebayMode === 'delist' && p.status !== 'listed') return false
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
  }), [parts,search,filterMake,filterModel,filterYear,filterCat,filterStatus,filterCond,hideSold,showDeleted,newOnly,newWindow,ebayMode])

  const carGroups = useMemo(() => {
    const g={}
    filtered.forEach(p => {
      const key=[p.make||'Unknown',p.model||'',p.year||'',p.car_id||''].join('|')
      if (!g[key]) g[key]={make:p.make||'Unknown',model:p.model||'',year:p.year||'',carId:p.car_id||null,parts:[]}
      g[key].parts.push(p)
    })
    return Object.values(g).sort((a,b)=>(a.make+a.model).localeCompare(b.make+b.model))
  }, [filtered])

  // Cars view is paged so Expand/scroll never has to build every part table at
  // once. Only the current page's cars can be opened, keeping the DOM bounded
  // no matter how large the yard is.
  const carPages = Math.max(1, Math.ceil(carGroups.length/carPageSize))
  useEffect(() => { if (carPage > carPages-1) setCarPage(0) }, [carPages, carPage])
  const pagedCars = useMemo(() => carGroups.slice(carPage*carPageSize,(carPage+1)*carPageSize), [carGroups,carPage,carPageSize])

  // Effective cost per part — the SAME estimate model the Dashboard/Analytics use
  // (recorded costs + acquisition base, labour, admin, storage). The raw costs
  // jsonb is all-zeros for imported parts, so totalCost() showed $0 for the whole
  // yard; this uses partEffectiveCost so the Cost/Profit columns are meaningful.
  // Precomputed once per filtered set (partEffectiveCost isn't free to call in a sort).
  const costMap = useMemo(() => { const m=new Map(); for(const p of filtered) m.set(p.id, partEffectiveCost(p, costing||{}).value); return m }, [filtered, costing])
  const eff = (p) => costMap.get(p.id) ?? partEffectiveCost(p, costing||{}).value

  // Click a column heading to sort the parts table by it.
  const [sort, setSort] = useState({ key: null, dir: 'asc' })
  const SORT_GETTERS = {
    'SKU': p=>p.sku||'', 'Title': p=>p.title||'', 'Make': p=>p.make||'', 'Model': p=>p.model||'',
    'Year': p=>p.year||'', 'Category': p=>(p.subcategory||p.category||''), 'Status': p=>p.status||'',
    'List$': p=>+p.list_price||0, 'Cost': p=>eff(p), 'Profit': p=>(+p.list_price||0)-eff(p),
  }
  const toggleSort = (key) => { if (!SORT_GETTERS[key]) return; setSort(s => s.key===key ? { key, dir: s.dir==='asc'?'desc':'asc' } : { key, dir:'asc' }); setPage(0) }
  const sortedFiltered = useMemo(() => {
    const get = SORT_GETTERS[sort.key]
    if (!get) return filtered
    const dir = sort.dir==='asc'?1:-1
    return [...filtered].sort((a,b)=>{ const av=get(a), bv=get(b); return (typeof av==='number'&&typeof bv==='number') ? (av-bv)*dir : String(av).localeCompare(String(bv))*dir })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort, costMap])

  // Inline cell save (spreadsheet-style editing in the By-Part table). Errors
  // surface via the app-level toast in onEdit; concurrency guard included there.
  const saveField = async (p, patch) => { try { await onEdit({ ...p, ...patch }) } catch (_) { /* toast shown upstream */ } }

  const paged = useMemo(() => sortedFiltered.slice(page*PAGE,(page+1)*PAGE), [sortedFiltered,page])
  const pages = Math.ceil(filtered.length/PAGE)
  const totals = filtered.reduce((acc,p) => { const c=eff(p),lp=+p.list_price||0; return{cost:acc.cost+c,list:acc.list+lp,profit:acc.profit+(lp-c),count:acc.count+1} }, {cost:0,list:0,profit:0,count:0})
  const clearFilters = () => { setSearch('');setFilterMake('');setFilterModel('');setFilterYear('');setFilterCat('');setFilterStatus('');setFilterCond('');setPage(0);setCarPage(0) }
  const handleDeleteCar = async group => { await onDeleteCar(group.carId||null, group.parts.map(p=>p.id)); setDeleteCarTarget(null) }

  const inputSm = { ...S.input, height:30, padding:'0 8px', fontSize:12 }
  const selSm = { ...S.select, height:30, padding:'0 8px', fontSize:12 }

  // While the store still holds sample data, every NEW part asks whether it's
  // more demo data or the user's first real record — so real inventory never
  // gets mixed into (and deleted with) the sample set. `pendingAdd` holds the
  // part + what to do after saving while the question is on screen.
  const [pendingAdd, setPendingAdd] = useState(null)
  const askOrAdd = async (p, after) => {
    if (sampleActive && p.isSample === undefined) { setPendingAdd({ p, after }); return }
    await onAdd(p)
    after?.()
  }
  const resolvePendingAdd = async isSample => {
    const { p, after } = pendingAdd
    setPendingAdd(null)
    try {
      await onAdd({ ...p, isSample })
      after?.()
    } catch (_) { /* toast shown upstream; form stays open */ }
  }

  const handleSaveAndAdd = async p => {
    await askOrAdd(p, () => {
      setEditingPart(null); setShowForm(false)
      setTimeout(() => setShowForm(true), 50)
    })
  }

  const samplePrompt = pendingAdd && (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:'22px 24px', maxWidth:440, width:'100%', boxShadow:'0 20px 50px rgba(0,0,0,0.3)' }}>
        <div style={{ fontSize:17, fontWeight:800, color:C.text, marginBottom:8 }}>🧪 Sample data is still in your store</div>
        <div style={{ fontSize:13.5, color:C.muted, lineHeight:1.6, marginBottom:18 }}>
          Is <strong style={{ color:C.text }}>{pendingAdd.p.title || 'this part'}</strong> more sample data to play with,
          or a permanent record of a real part? Sample data is deleted when you click
          "Remove sample data" in the banner — permanent records stay.
        </div>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <button onClick={() => resolvePendingAdd(false)} style={{ ...S.btn(), flex:1, padding:'11px 0', fontSize:14 }}>✅ Permanent record</button>
          <button onClick={() => resolvePendingAdd(true)} style={{ ...S.btn('secondary'), flex:1, padding:'11px 0', fontSize:14 }}>🧪 More sample data</button>
        </div>
        <div style={{ textAlign:'center', marginTop:12 }}>
          <span style={{ fontSize:12.5, color:C.muted, cursor:'pointer' }} onClick={() => setPendingAdd(null)}>Cancel — keep editing</span>
        </div>
      </div>
    </div>
  )

  if (showForm) return (
    <>
    {samplePrompt}
    <PartForm part={editingPart} cars={cars} storeId={storeId} aiSettings={aiSettings} footer={footer} costing={costing} labels={labels} warehouse={warehouse} allParts={parts}
      onSave={async p => {
        try {
          if (editingPart) await onEdit({ ...editingPart, ...p })
          else { await askOrAdd(p, () => { setShowForm(false); setEditingPart(null) }); return }
          setShowForm(false); setEditingPart(null)
        } catch (e) {
          if (e?.code === 'STALE') { alert('This part was changed by someone else since you opened it.\n\nYour edits have NOT been saved. Close and reopen the part to see their changes, then re-apply yours.') }
          else if (e?.code === 'DUP_SKU') { alert(e.message) }   // already plain English, no "Save failed" noise
          else { alert('Save failed: ' + (e?.message || 'unknown error')); }
          // keep the form open so edits aren't lost
        }
      }}
      onSaveAndAdd={handleSaveAndAdd}
      onCancel={() => { setShowForm(false); setEditingPart(null) }}
    />
    </>
  )

  return (
    <div>
      {samplePrompt}
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
            <button onClick={() => setViewMode('bulk')} style={{ padding:'5px 14px', fontSize:12, fontWeight:600, background:viewMode==='bulk'?C.accent:'white', color:viewMode==='bulk'?'white':C.muted, border:'none', cursor:'pointer', borderLeft:`1px solid ${C.border}` }}>✏️ Bulk edit</button>
          </div>
          {/* eBay listing mode — filters to parts to list (in-stock) or de-list (listed) and turns on row selection. */}
          <div style={{ display:'flex', borderRadius:8, overflow:'hidden', border:`1.5px solid ${EBAY_BLUE}55` }} title="Select parts to list on / de-list from eBay">
            {[['off','🛒 eBay','Turn off eBay selection mode'],['list','List','Show in-stock parts and select which to list on eBay'],['delist','De-list','Show live listings and select which to end on eBay']].map(([m,lbl,tip],i) => (
              <button key={m} onClick={() => { setEbayMode(m); if (m!=='off') setViewMode('parts') }} title={tip}
                style={{ padding:'5px 12px', fontSize:12, fontWeight:600, background:ebayMode===m?EBAY_BLUE:'white', color:ebayMode===m?'white':(m==='off'?C.muted:EBAY_BLUE), border:'none', cursor:'pointer', borderLeft:i?`1px solid ${EBAY_BLUE}33`:'none' }}>{lbl}</button>
            ))}
          </div>
          <span style={{ fontSize:12, color:C.muted, background:C.panel, borderRadius:10, padding:'2px 10px', fontWeight:600 }}>{totals.count} parts</span>
        </div>
      </div>

      {viewMode==='bulk' && <BulkEdit storeId={storeId} parts={parts} onSaved={refetch} />}

      {viewMode!=='bulk' && <>
      {(assessRunning || assessRemaining > 0) && (
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:14, padding:'10px 14px', borderRadius:10, background: assessBlocked ? '#fffbeb' : assessRunning ? '#f5f3ff' : '#fffbeb', border:`1px solid ${assessBlocked ? '#f59e0b' : assessRunning ? '#ddd6fe' : '#fcd34d'}` }}>
          <span style={{ fontSize:16 }}>{assessBlocked ? '⚠️' : assessRunning ? '🤖' : '⏳'}</span>
          <div style={{ flex:1, minWidth:200, fontSize:13, color:C.text }}>
            {assessRunning
              ? <><strong>Preparing parts for eBay in the background…</strong> {assessDone}/{assessTotal}{assessEtaTxt?` · ${assessEtaTxt}`:''} — AI assessment + item specifics; you can keep working, results save automatically.</>
              : assessBlocked === 'ai-credit'
                ? <><strong>{assessRemaining}</strong> part{assessRemaining===1?'':'s'} paused — <strong>AI credit is exhausted</strong>. Top up billing at <code>console.anthropic.com</code> → Settings → Billing, then reload.</>
                : assessBlocked === 'ebay-specifics'
                  ? <><strong>{assessRemaining}</strong> part{assessRemaining===1?'':'s'} can’t finish — the eBay-specifics step can’t save. Run migration <code>20260718_parts_ebay_specifics.sql</code> then reload.</>
                  : assessPaused
                    ? <><strong>{assessRemaining}</strong> part{assessRemaining===1?'':'s'} to prepare (paused).</>
                    : assessRetry != null
                      ? <><strong>{assessRemaining}</strong> part{assessRemaining===1?'':'s'} waiting — retrying in {assessRetry}s (AI/eBay was busy).</>
                      : <><strong>{assessRemaining}</strong> part{assessRemaining===1?'':'s'} waiting to be prepared for eBay…</>}
          </div>
          <button onClick={toggleAssessPaused} style={{ ...S.btn('secondary'), padding:'5px 14px', fontSize:12 }}>
            {assessPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      )}
      {(() => { const activeFilters = [filterMake, filterModel, filterYear, filterCat, filterStatus, filterCond].filter(Boolean).length + (hideSold?1:0) + (newOnly?1:0); return (
      <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:12 }}>
        {/* Slim inventory-value chips */}
        {[['Stock Value',`$${totals.list.toFixed(0)}`,C.blue],['Cost',`$${totals.cost.toFixed(0)}`,C.red],['Est. Profit',`$${totals.profit.toFixed(0)}`,totals.profit>=0?C.green:C.red]].map(([l,v,col])=>(
          <div key={l} style={{ display:'flex', alignItems:'baseline', gap:7, background:C.card, border:`1px solid ${C.border}`, borderLeft:`3px solid ${col}`, borderRadius:8, padding:'5px 12px' }}>
            <span style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:'0.5px' }}>{l}</span>
            <span style={{ fontSize:16, fontWeight:800, color:col }}>{v}</span>
          </div>
        ))}
        <div style={{ width:1, height:22, background:C.border, margin:'0 2px' }} />
        <input style={{ ...inputSm, flex:2, minWidth:180 }} placeholder="🔍 Search everything..." value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
        <button onClick={() => setShowFilters(v=>!v)} title="Make, model, year, category, status, condition…" style={{ ...S.btn('secondary'), padding:'0 12px', height:30, fontSize:12, display:'flex', alignItems:'center', gap:6 }}>
          ⚙ Filters{activeFilters?<span style={{ background:C.accent, color:'#fff', borderRadius:10, padding:'0 6px', fontSize:11, fontWeight:700 }}>{activeFilters}</span>:null} <span style={{ fontSize:10 }}>{showFilters?'▲':'▼'}</span>
        </button>
        {(activeFilters>0||search) && <button onClick={() => { clearFilters(); }} title="Clear search + all filters" style={{ ...S.btn('secondary'), padding:'0 12px', height:30, fontSize:12 }}>Clear</button>}
        <span style={{ fontSize:12, color:C.muted }}>{filtered.length} matching</span>
      </div>
      )})()}

      {showFilters && (
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:'12px 16px', marginBottom:14 }}>
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
      )}
      </>}

      {viewMode==='car' && (
        <div>
          <div style={{ display:'flex', gap:8, marginBottom:10, alignItems:'center', flexWrap:'wrap' }}>
            <span style={{ fontSize:13, color:C.muted }}>{carGroups.length} car{carGroups.length!==1?'s':''}</span>
            {expandedCars.size>0 && <button onClick={() => setExpandedCars(new Set())} style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11 }}>Collapse open ({expandedCars.size})</button>}
            <span style={{ flex:1 }} />
            <span style={{ fontSize:12, color:C.muted }}>Per page</span>
            <select value={carPageSize} onChange={e=>{ setCarPageSize(+e.target.value); setCarPage(0) }} style={{ ...selSm, width:70 }}>
              {[20,25,50,100].map(n=><option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {bulkAIGroup && <BulkAIPanel group={bulkAIGroup} aiSettings={aiSettings} footer={footer} storeId={storeId} onComplete={() => setBulkAIGroup(null)} />}
          {pagedCars.map(g => {
            const key=g.make+'|'+g.model+'|'+g.year+'|'+(g.carId||'')
            const isOpen=expandedCars.has(key)
            const gList=g.parts.reduce((a,p)=>a+(+p.list_price||0),0)
            const gCost=g.parts.reduce((a,p)=>a+eff(p),0)
            const gProfit=gList-gCost
            const gStock=g.parts.filter(p=>p.status==='in_stock').length
            const gListed=g.parts.filter(p=>p.status==='listed').length
            const gSold=g.parts.filter(p=>p.status==='sold').length
            const aiPending=g.parts.filter(p=>!p.ai_assessed).length
            return (
              <div key={key} style={{ ...S.card, marginBottom:8, padding:0, overflow:'hidden', contentVisibility:'auto', containIntrinsicSize:'auto 64px' }}>
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
                    {(() => { const n = g.parts.filter(p=>!p.ai_assessed && partHasPhoto(p)).length; return (
                      <button onClick={e=>{e.stopPropagation(); if(n) setBulkAIGroup(g)}} disabled={!n}
                        title={n ? `Run AI assessment on the ${n} part${n===1?'':'s'} in this car that need it` : 'All parts in this car are assessed (or have no photo to assess)'}
                        style={{ ...S.btn(n?'blue':'secondary'), padding:'5px 12px', fontSize:12, flexShrink:0, opacity:n?1:0.45, cursor:n?'pointer':'default' }}>✨ AI{n?` (${n})`:''}</button>
                    )})()}
                    <button onClick={e=>{e.stopPropagation();setDeleteCarTarget(g)}} title="Delete this car and its parts" style={{ ...S.btn('danger'), padding:'5px 12px', fontSize:12, flexShrink:0 }}>🗑 Delete Car</button>
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
                          const cost=eff(p),lp=+p.list_price||0,pr=lp-cost
                          return (
                            <tr key={p.id} style={{ background:i%2===0?'white':'#faf9f7', borderBottom:`1px solid ${C.border}` }}>
                              <td style={{ padding:'8px 12px', maxWidth:260, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                <span title={p.title} style={{ fontWeight:500 }}>{p.title||'Untitled'}</span>
                                {p.partNumber&&<span style={{ fontSize:11, color:C.muted, marginLeft:8 }}>#{p.partNumber}</span>}
                              </td>
                              <td style={{ padding:'8px 12px', fontSize:12, color:C.muted, whiteSpace:'nowrap' }}>{p.subcategory||p.category}</td>
                              <td style={{ padding:'8px 12px', fontSize:12, color:C.muted, whiteSpace:'nowrap' }}>{p.condition}</td>
                              <td style={{ padding:'8px 12px' }}><StatusPill part={p} /></td>
                              <td style={{ padding:'8px 12px', textAlign:'center' }}>{!partHasPhoto(p)
                                ? <span title="Add a photo — AI assessment needs one">📷</span>
                                : <span title={p.ai_assessed?'AI Assessed':'Needs AI'}>{p.ai_assessed?'✅':'⬜'}</span>}</td>
                              <td style={{ padding:'8px 12px', fontWeight:700, whiteSpace:'nowrap' }}>${lp.toFixed(0)}</td>
                              <td style={{ padding:'8px 12px', color:C.red, whiteSpace:'nowrap' }}>${cost.toFixed(0)}</td>
                              <td style={{ padding:'8px 12px', fontWeight:600, color:pr>=0?C.green:C.red, whiteSpace:'nowrap' }}>${pr.toFixed(0)}</td>
                              <td style={{ padding:'8px 12px', whiteSpace:'nowrap' }}>
                                <button onClick={()=>{setEditingPart(p);setShowForm(true)}} title="Edit this part's details" style={{ ...S.btn('secondary'), padding:'3px 10px', fontSize:11, marginRight:6 }}>Edit</button>
                                <button onClick={()=>openPreview(p)} title="Preview the eBay listing (category, specifics, fitment) — and edit it" style={{ ...S.btn('secondary'), padding:'3px 8px', fontSize:11, marginRight:6 }}>👁</button>
                                {p.sku && <button onClick={()=>printLabels(p, labels)} title="Print stock label" style={{ ...S.btn('secondary'), padding:'3px 8px', fontSize:11, marginRight:6 }}>🏷️</button>}
                                <EbayLink part={p} style={{ ...S.btn('secondary'), padding:'3px 8px', marginRight:6 }} />
                                <button onClick={()=>setDeleteTarget(p)} title="Delete this part" style={{ ...S.btn('danger'), padding:'3px 8px', fontSize:11 }}>🗑</button>
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
          {carPages>1&&(
            <div style={{ display:'flex', gap:8, alignItems:'center', justifyContent:'center', marginTop:12 }}>
              <button disabled={carPage===0} onClick={()=>{ setExpandedCars(new Set()); setCarPage(p=>p-1); window.scrollTo(0,0) }} style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12 }}>← Prev</button>
              <span style={{ fontSize:13, color:C.muted }}>Page {carPage+1} of {carPages} ({carGroups.length} cars)</span>
              <button disabled={carPage>=carPages-1} onClick={()=>{ setExpandedCars(new Set()); setCarPage(p=>p+1); window.scrollTo(0,0) }} style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12 }}>Next →</button>
            </div>
          )}
          {!carGroups.length&&<div style={{ textAlign:'center', color:C.muted, padding:60, fontSize:15 }}>No cars match your filters.</div>}
        </div>
      )}

      {viewMode==='parts' && (
        <div>
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10, flexWrap:'wrap' }}>
            {pages>1&&(<>
              <button disabled={page===0} onClick={()=>setPage(p=>p-1)} style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12 }}>← Prev</button>
              <span style={{ fontSize:13, color:C.muted }}>Page {page+1} of {pages} ({filtered.length} parts)</span>
              <button disabled={page===pages-1} onClick={()=>setPage(p=>p+1)} style={{ ...S.btn('secondary'), padding:'4px 12px', fontSize:12 }}>Next →</button>
            </>)}
            <span style={{ fontSize:12, color:C.muted }}>💡 Click any cell to edit it in place — Enter saves, Esc cancels. Use ✏️ Bulk edit for mass changes.</span>
            <div style={{ flex:1 }} />
            <label style={{ fontSize:12, color:C.muted, display:'flex', alignItems:'center', gap:6 }}>
              Show
              <select value={PAGE} onChange={e=>setPageSize(+e.target.value)} title="Records per page" style={{ ...selSm, padding:'4px 8px', minWidth:0 }}>
                {[20,50,100,250,500].map(n=><option key={n} value={n}>{n}</option>)}
              </select>
              per page
            </label>
          </div>
          <div ref={tableRef} className="pv-scroll" style={{ overflowX:'scroll', overflowY:'scroll', maxHeight: tableH ? tableH - (ebayMode!=='off'?72:0) : '60vh', borderRadius:6, border:`1px solid ${C.border}` }}>
            <table style={{ borderCollapse:'collapse', fontSize:13, minWidth:BYPART_MINW, width:'100%', tableLayout:'fixed', zoom:'var(--table-zoom, 1)' }}>
              <colgroup>{BYPART_COLS.map(([h,w])=><col key={h} style={{ width:w }} />)}</colgroup>
              <thead style={{ position:'sticky', top:0, zIndex:10 }}>
                <tr style={{ background:'#f5f4f0' }}>
                  {/* Column widths are locked by the colgroup + table-layout:fixed, so the
                      grid is identical across By-Part / List / De-list. */}
                  {BYPART_COLS.map(([h,w,align])=>{
                    const sortable = !!SORT_GETTERS[h]
                    return (
                    <th key={h} onClick={sortable?()=>toggleSort(h):undefined} title={sortable?`Sort by ${h}`:undefined}
                      style={{ padding:'8px 8px', textAlign:align||'left', fontSize:10, fontWeight:700, textTransform:'uppercase', color: sort.key===h?C.accent:C.muted, background:'#f5f4f0', borderBottom:`2px solid ${C.accent}`, borderRight:`1px solid ${C.border}`, whiteSpace:'nowrap', overflow:'hidden', cursor: sortable?'pointer':'default', userSelect:'none' }}>
                      {h==='Edit' && ebayMode!=='off'
                        ? <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
                            <input type="checkbox" title="Select all on this page" checked={paged.length>0 && paged.every(p=>sel.has(p.id))} onChange={()=>setSel(s=>{ const n=new Set(s); const all=paged.every(p=>n.has(p.id)); paged.forEach(p=>all?n.delete(p.id):n.add(p.id)); return n })} style={{ width:15, height:15, cursor:'pointer' }} />
                            {h}
                          </span>
                        : <>{h}{sortable && <span style={{ color: sort.key===h?C.accent:'#cbd5e1' }}>{sort.key===h?(sort.dir==='asc'?' ▲':' ▼'):' ↕'}</span>}</>}
                    </th>
                  )})}
                </tr>
              </thead>
              <tbody>
                {paged.map((p,i)=>{
                  const cost=eff(p),lp=+p.list_price||0,pr=lp-cost
                  const bg=p.deletedAt?'#fff5f5':p.status==='sold'?'#f0fdf4':i%2===0?'#ffffff':'#faf9f7'
                  const td=(v,col,bold,align)=><td style={{ padding:'4px 8px', fontSize:12, color:col||C.text, fontWeight:bold?700:400, textAlign:align||'left', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}`, overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' }} title={String(v??'')}>{v||<span style={{color:C.border}}>—</span>}</td>
                  return (
                    <tr key={p.id} style={{ background: ebayMode!=='off' && sel.has(p.id) ? '#eef2ff' : bg }}>
                      <td style={{ padding:'4px 6px', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}`, whiteSpace:'nowrap' }}>
                        {ebayMode!=='off' && <input type="checkbox" checked={sel.has(p.id)} onChange={()=>toggleSel(p.id)} style={{ width:15, height:15, cursor:'pointer', marginRight:6, verticalAlign:'middle' }} />}
                        <button onClick={()=>{setEditingPart(p);setShowForm(true)}} title="Edit this part's details" style={{ fontSize:11, padding:'2px 8px', background:'#eff6ff', color:C.blue, border:`1px solid ${C.blue}44`, borderRadius:4, cursor:'pointer', marginRight:4 }}>Edit</button>
                        <button onClick={()=>openPreview(p)} title="Preview the eBay listing (category, specifics, fitment) — and edit it" style={{ fontSize:11, padding:'2px 6px', background:'#fff', color:C.text, border:`1px solid ${C.border}`, borderRadius:4, cursor:'pointer', marginRight:4 }}>👁</button>
                        {p.sku && <button onClick={()=>printLabels(p, labels)} title="Print stock label" style={{ fontSize:11, padding:'2px 6px', background:'#fff', color:C.text, border:`1px solid ${C.border}`, borderRadius:4, cursor:'pointer' }}>🏷️</button>}
                        <EbayLink part={p} style={{ padding:'2px 6px', background:'#fff', border:`1px solid ${C.border}`, borderRadius:4, marginLeft:4 }} />
                      </td>
                      <EditableTd value={p.sku} onSave={v => saveField(p, { sku: v })} />
                      <EditableTd value={p.title} title={p.isSample ? `SAMPLE DATA — ${p.title}` : (+p.quantity > 1 ? `${p.title} — ${Math.max(0, p.quantity - (p.quantitySold || 0))} of ${p.quantity} in stock` : p.title)}
                        display={(p.isSample || +p.quantity > 1) ? <span>{p.isSample ? '🧪 ' : ''}{p.title}{+p.quantity > 1 ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: C.accent, background: C.accentSoft, border: `1px solid ${C.border}`, borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap' }}>×{Math.max(0, p.quantity - (p.quantitySold || 0))}</span> : null}</span> : undefined}
                        onSave={v => saveField(p, { title: v })} />
                      <EditableTd value={p.make} onSave={v => saveField(p, { make: v })} />
                      <EditableTd value={p.model} onSave={v => saveField(p, { model: v })} />
                      <EditableTd value={p.year} onSave={v => saveField(p, { year: v })} />
                      <EditableTd value={canonicalCategory(p.category)} display={p.subcategory || p.category || undefined} title={p.subcategory || p.category}
                        type="select" options={CATEGORY_NAMES.map(c => [c, c])}
                        onSave={v => saveField(p, { category: v, subcategory: '' })} />
                      <EditableTd value={p.status} display={<StatusPill part={p} fontSize={10} padding="1px 6px" />}
                        type="select" options={Object.entries(STATUS_LABELS)}
                        onSave={v => saveField(p, { status: v })} />
                      <td style={{ padding:'4px 8px', textAlign:'center', borderBottom:`1px solid ${C.border}`, borderRight:`1px solid ${C.border}` }}>
                        {!partHasPhoto(p)
                          ? <span title="Add a photo — AI assessment needs one">📷</span>
                          : <span title={p.ai_assessed?'AI Assessed':'Needs AI'}>{p.ai_assessed?'✅':'⬜'}</span>}
                      </td>
                      <EditableTd value={p.list_price || ''} display={lp > 0 ? `$${lp.toFixed(0)}` : undefined} type="number" align="right" bold
                        onSave={v => saveField(p, { listPrice: +v || 0, list_price: +v || 0 })} />
                      {td(`$${cost.toFixed(0)}`,C.red,false,'right')}
                      {td(`$${pr.toFixed(0)}`,pr>=0?C.green:C.red,true,'right')}
                      <td style={{ padding:'4px 6px', textAlign:'center', borderBottom:`1px solid ${C.border}` }}>
                        <button onClick={()=>setDeleteTarget(p)} title="Delete this part" style={{ fontSize:11, padding:'2px 6px', background:'#fef2f2', color:C.red, border:`1px solid ${C.red}44`, borderRadius:4, cursor:'pointer' }}>🗑</button>
                      </td>
                    </tr>
                  )
                })}
                {!paged.length&&<tr><td colSpan={13} style={{ textAlign:'center', padding:40, color:C.muted }}>No parts match your filters.</td></tr>}
              </tbody>
              <tfoot>
                {(() => { const ftd = { background:'#17150F', position:'sticky', bottom:0, zIndex:11 }; return (
                <tr>
                  <td colSpan={9} style={{ ...ftd, padding:'6px 12px', fontSize:11, color:'rgba(255,255,255,0.5)', fontWeight:600 }}>TOTALS ({totals.count} parts)</td>
                  <td style={{ ...ftd, padding:'6px 8px', textAlign:'right', fontSize:12, fontWeight:700, color:'#93c5fd' }}>${totals.list.toFixed(0)}</td>
                  <td style={{ ...ftd, padding:'6px 8px', textAlign:'right', fontSize:12, fontWeight:700, color:'#fca5a5' }}>${totals.cost.toFixed(0)}</td>
                  <td style={{ ...ftd, padding:'6px 8px', textAlign:'right', fontSize:12, fontWeight:700, color:totals.profit>=0?'#86efac':'#fca5a5' }}>${totals.profit.toFixed(0)}</td>
                  <td style={ftd} />
                </tr>
                )})()}
              </tfoot>
            </table>
          </div>
          {ebayMode!=='off' && <EbayActions storeId={storeId} selectedParts={parts.filter(p=>sel.has(p.id))} onDone={refetch} onClear={()=>setSel(new Set())} />}
        </div>
      )}
      {previewPart && <ListingPreview storeId={storeId} part={previewPart} onClose={()=>setPreviewPart(null)} onChanged={refetch} />}
    </div>
  )
}

