import { useState, useEffect } from 'react'
import { C, S, fmt } from '../lib/constants'
import { sb } from '../lib/supabase'
import { previewListing } from '../lib/ebay'

const EBAY_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'
const callEbay = async (payload) => {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(EBAY_FN, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }, body: JSON.stringify(payload) })
  const d = await res.json()
  if (!res.ok || d.error) throw new Error(d.error || 'Request failed')
  return d
}
const blankFit = () => ({ make: '', model: '', yearFrom: '', yearTo: '', trim: '' })

// eBay listing preview for one part — the exact category / item specifics /
// fitment / photos / description a publish would send. Read-only by default;
// ✏️ Edit turns on inline editing of the category (search the live eBay tree),
// item specifics, and compatible vehicles, persisted as ebay_overrides (which
// win at publish). Hydrates instantly from the background snapshot when current.
export default function ListingPreview({ storeId, part, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [fromCache, setFromCache] = useState(false)
  const [editing, setEditing] = useState(false)
  const [specEdits, setSpecEdits] = useState({})   // name -> value
  const [fitEdits, setFitEdits] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Category editor
  const [catEditing, setCatEditing] = useState(false)
  const [catQuery, setCatQuery] = useState('')
  const [catSugs, setCatSugs] = useState([])
  const [catSearching, setCatSearching] = useState(false)

  const hydrate = (d) => {
    setData(d)
    const se = {}; (d.specifics || []).forEach(s => { se[s.name] = s.value || '' }); setSpecEdits(se)
    setFitEdits((d.fitment || []).map(f => ({ make: f.make || '', model: f.model || '', yearFrom: f.yearFrom || '', yearTo: f.yearTo || '', trim: f.trim || '' })))
  }
  const build = async () => {
    setLoading(true); setErr(''); setFromCache(false)
    try { hydrate(await previewListing(storeId, part.id)) }
    catch (e) { setErr(e.message) }
    setLoading(false)
  }
  useEffect(() => {
    const cached = part?.ebaySpecifics
    const sig = JSON.stringify({ t: part.title || '', p: +part.list_price || 0, c: part.condition || '', d: part.description || '', ov: part.ebayOverrides || null })
    if (cached && cached.sig === sig) { hydrate(cached); setFromCache(true) }
    else build()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part?.id])

  const specifics = data?.specifics || []
  const blankRequired = specifics.filter(s => s.required && !(specEdits[s.name] || '').trim())

  // ── Save item-specific + fitment overrides (same shape as the part editor) ──
  const save = async () => {
    setSaving(true); setErr('')
    try {
      const merged = { ...(part.ebayOverrides?.specifics || {}) }
      specifics.forEach(s => { const v = (specEdits[s.name] || '').trim(); if (v && v !== (s.value || '')) merged[s.name] = v })
      const newOv = { ...(part.ebayOverrides || {}), specifics: merged,
        fitment: fitEdits.filter(r => r.make && r.model).map(r => ({ make: r.make, model: r.model, yearFrom: +r.yearFrom || undefined, yearTo: +r.yearTo || +r.yearFrom || undefined, trim: r.trim || '' })) }
      const { error } = await sb.from('parts').update({ ebay_overrides: newOv }).eq('id', part.id)
      if (error) throw error
      part.ebayOverrides = newOv // keep the local copy current for the sig check
      onChanged?.()
      setSaved(true); setTimeout(() => setSaved(false), 2000)
      setEditing(false)
      await build()
    } catch (e) { setErr(e.message) }
    setSaving(false)
  }

  // ── Category editor ──
  const askEditCategory = () => { if (window.confirm('Change the eBay category for this listing?')) { setCatEditing(true); setCatSugs([]); setCatQuery(part.title || `${part.make || ''} ${part.subcategory || part.category || ''}`.trim()) } }
  const searchCats = async () => {
    const q = catQuery.trim(); if (!q) return
    setCatSearching(true); setErr('')
    try { const d = await callEbay({ action: 'category_suggestions', storeId, query: q }); setCatSugs(d.suggestions || []) }
    catch (e) { setErr(e.message) }
    setCatSearching(false)
  }
  const applyCat = async (sug) => {
    setCatSearching(true); setErr('')
    try { await callEbay({ action: 'set_category', storeId, partId: part.id, categoryId: sug.id, categoryName: sug.name }); setCatEditing(false); setCatSugs([]); onChanged?.(); await build() }
    catch (e) { setErr(e.message) }
    setCatSearching(false)
  }

  const setFit = (i, k, v) => setFitEdits(rows => rows.map((r, j) => j === i ? { ...r, [k]: v } : r))
  const inp = { ...S.input, marginBottom: 0, padding: '5px 8px', fontSize: 12 }

  return (
    <div onClick={() => !saving && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 760, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>eBay listing preview {fromCache && !editing && <span title="Shown from the pre-generated snapshot" style={{ color: C.green }}>· cached ⚡</span>}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginTop: 2 }}>{data?.title || part.title || 'Untitled'}</div>
          </div>
          {!editing
            ? <button onClick={() => setEditing(true)} title="Edit the category, item specifics and compatible vehicles for this listing" style={{ ...S.btn('secondary'), padding: '7px 14px', fontSize: 13 }}>✏️ Edit</button>
            : <button onClick={() => { setEditing(false); hydrate(data); }} title="Discard edits and return to the preview" style={{ ...S.btn('secondary'), padding: '7px 14px', fontSize: 13 }}>Done editing</button>}
          <button onClick={onClose} title="Close the preview" style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: C.muted }}>×</button>
        </div>

        <div style={{ overflowY: 'auto', padding: 20 }}>
          {loading ? <div style={{ color: C.muted, padding: 30, textAlign: 'center' }}>Building preview…</div>
           : !data ? (err ? <div style={{ color: C.red, padding: 16 }}>✗ {err}</div> : null) : (
            <>
              {err && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>✗ {err}</div>}
              {(data.photos || []).length > 0 && (
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
                  {data.photos.slice(0, 12).map((u, i) => <img key={i} src={u} alt="" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, flexShrink: 0, border: `1px solid ${C.border}` }} />)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <Fact label="Price" value={fmt(data.price)} strong />
                <Fact label="Condition" value={data.condition} />
                {/* Category — clickable to edit */}
                <button onClick={editing ? askEditCategory : () => setEditing(true)} title={editing ? 'Click to change the eBay category' : 'Edit to change the category'}
                  style={{ textAlign: 'left', cursor: 'pointer', background: C.bg, border: `1px solid ${editing ? C.accent : C.border}`, borderRadius: 8, padding: '6px 12px', minWidth: 120 }}>
                  <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>Category {editing && <span style={{ color: C.accent }}>✎</span>}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{data.categoryName || data.categoryId || '—'}</div>
                </button>
                {data.weightG ? <Fact label="Weight" value={`${(data.weightG / 1000).toFixed(2)} kg`} /> : null}
              </div>

              {/* Category search (edit) */}
              {catEditing && (
                <div style={{ border: `1px solid ${C.accent}`, borderRadius: 10, padding: 12, marginBottom: 16, background: '#fff7ed' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={catQuery} onChange={e => setCatQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchCats()} placeholder="Search eBay categories…" style={{ ...S.input, marginBottom: 0, flex: 1 }} />
                    <button onClick={searchCats} disabled={catSearching} title="Search eBay's category tree" style={{ ...S.btn('primary'), padding: '9px 14px' }}>{catSearching ? '…' : 'Search'}</button>
                    <button onClick={() => setCatEditing(false)} title="Cancel category change" style={{ ...S.btn('secondary'), padding: '9px 14px' }}>Cancel</button>
                  </div>
                  {catSugs.length > 0 && (
                    <div style={{ marginTop: 8, maxHeight: 200, overflowY: 'auto' }}>
                      {catSugs.map((s, i) => (
                        <button key={i} onClick={() => applyCat(s)} title="Use this category" style={{ display: 'block', width: '100%', textAlign: 'left', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', marginBottom: 4, cursor: 'pointer', fontSize: 12.5 }}>
                          {s.name} <span style={{ color: C.muted }}>· {s.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {blankRequired.length > 0 && !editing && (
                <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
                  ⚠ {blankRequired.length} required item specific{blankRequired.length === 1 ? '' : 's'} still blank: {blankRequired.map(s => s.name).join(', ')}.
                </div>
              )}

              {/* Item specifics */}
              <Group title={`Item specifics${editing ? ' — editable' : ''}`}>
                {specifics.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>None generated yet.</div> : editing ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {specifics.map((s, i) => (
                      <label key={i} style={{ fontSize: 12 }}>
                        <span style={{ color: C.muted }}>{s.name}{s.required ? ' *' : ''}</span>
                        {s.options && s.options.length ? (
                          <select value={specEdits[s.name] || ''} onChange={e => setSpecEdits(x => ({ ...x, [s.name]: e.target.value }))} style={{ ...inp, width: '100%' }}>
                            <option value="">—</option>
                            {!s.options.includes(specEdits[s.name]) && specEdits[s.name] && <option value={specEdits[s.name]}>{specEdits[s.name]} (custom)</option>}
                            {s.options.map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input value={specEdits[s.name] || ''} onChange={e => setSpecEdits(x => ({ ...x, [s.name]: e.target.value }))} placeholder="—" style={{ ...inp, width: '100%' }} />
                        )}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 18px' }}>
                    {specifics.filter(s => (specEdits[s.name] || '').trim()).map((s, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '3px 0', borderBottom: `1px solid ${C.bg}` }}>
                        <span style={{ color: C.muted }}>{s.name}{s.required ? ' *' : ''}</span>
                        <span style={{ color: C.text, fontWeight: 600, textAlign: 'right' }}>{specEdits[s.name]}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Group>

              {/* Fitment */}
              <Group title={`Compatible vehicles (${editing ? fitEdits.length : (data.fitment || []).length})${editing ? ' — editable' : ''}`}>
                {editing ? (
                  <div>
                    {fitEdits.map((f, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 0.7fr 0.7fr 1fr auto', gap: 6, marginBottom: 6 }}>
                        <input value={f.make} onChange={e => setFit(i, 'make', e.target.value)} placeholder="Make" style={inp} />
                        <input value={f.model} onChange={e => setFit(i, 'model', e.target.value)} placeholder="Model" style={inp} />
                        <input value={f.yearFrom} onChange={e => setFit(i, 'yearFrom', e.target.value.replace(/\D/g, ''))} placeholder="From" style={inp} />
                        <input value={f.yearTo} onChange={e => setFit(i, 'yearTo', e.target.value.replace(/\D/g, ''))} placeholder="To" style={inp} />
                        <input value={f.trim} onChange={e => setFit(i, 'trim', e.target.value)} placeholder="Trim (opt)" style={inp} />
                        <button onClick={() => setFitEdits(rows => rows.filter((_, j) => j !== i))} title="Remove this vehicle" style={{ ...S.btn('secondary'), padding: '2px 10px', color: C.red }}>×</button>
                      </div>
                    ))}
                    <button onClick={() => setFitEdits(rows => [...rows, blankFit()])} title="Add a compatible vehicle / year range" style={{ ...S.btn('secondary'), padding: '6px 12px', fontSize: 12, marginTop: 4 }}>+ Add vehicle</button>
                  </div>
                ) : (data.fitment || []).length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>No fitment listed. <button onClick={() => setEditing(true)} title="Add compatible vehicles" style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0 }}>Add vehicles</button></div> : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {data.fitment.slice(0, 40).map((f, i) => (
                      <span key={i} style={{ fontSize: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 8px' }}>
                        {[f.make, f.model, [f.yearFrom, f.yearTo].filter(Boolean).join('–'), f.trim].filter(Boolean).join(' ')}
                      </span>
                    ))}
                  </div>
                )}
              </Group>

              {!editing && (
                <Group title="Description">
                  <div style={{ fontSize: 13, color: C.text, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', lineHeight: 1.5, background: '#fafaf9', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12 }}>{data.description || '—'}</div>
                </Group>
              )}
            </>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: C.muted }}>{saved ? <span style={{ color: C.green }}>✓ saved — wins at publish</span> : editing ? 'Edits save as overrides and win at publish.' : 'Exactly what a publish would send.'}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {editing
              ? <button onClick={save} disabled={saving} title="Save your category / specifics / vehicle edits" style={{ ...S.btn('primary'), padding: '8px 16px', fontSize: 13, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : '💾 Save changes'}</button>
              : <button onClick={build} disabled={loading} title="Rebuild the preview from the part's photos" style={{ ...S.btn('secondary'), padding: '8px 14px', fontSize: 13, opacity: loading ? 0.6 : 1 }}>↻ Rebuild</button>}
            <button onClick={onClose} title="Close the preview" style={{ ...S.btn('secondary'), padding: '8px 16px', fontSize: 13 }}>Close</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value, strong }) {
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 12px', minWidth: 90 }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: strong ? 16 : 14, fontWeight: strong ? 800 : 600, color: C.text }}>{value}</div>
    </div>
  )
}
function Group({ title, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}
