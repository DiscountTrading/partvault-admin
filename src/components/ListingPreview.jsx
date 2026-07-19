import { useState, useEffect } from 'react'
import { C, S, fmt } from '../lib/constants'
import { previewListing } from '../lib/ebay'

// Read-only preview of the exact eBay listing a publish would send for one part —
// category, item specifics, fitment, photos, description, shipping. Hydrates
// INSTANTLY from the background-generated snapshot (part.ebaySpecifics) when it's
// still current, otherwise asks the edge to build it on demand.
export default function ListingPreview({ storeId, part, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [fromCache, setFromCache] = useState(false)

  const build = async () => {
    setLoading(true); setErr(''); setFromCache(false)
    try { setData(await previewListing(storeId, part.id)) }
    catch (e) { setErr(e.message) }
    setLoading(false)
  }

  useEffect(() => {
    // Snapshot sig fingerprints the saved inputs; if it matches, use the cache.
    const cached = part?.ebaySpecifics
    const sig = JSON.stringify({ t: part.title || '', p: +part.list_price || 0, c: part.condition || '', d: part.description || '', ov: part.ebayOverrides || null })
    if (cached && cached.sig === sig) { setData(cached); setFromCache(true) }
    else build()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part?.id])

  const specifics = data?.specifics || []
  const filled = specifics.filter(s => (s.value || '').trim())
  const blankRequired = specifics.filter(s => s.required && !(s.value || '').trim())
  const fitment = data?.fitment || []
  const photos = data?.photos || []

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 760, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>eBay listing preview {fromCache && <span title="Shown from the pre-generated snapshot" style={{ color: C.green }}>· cached ⚡</span>}</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginTop: 2 }}>{data?.title || part.title || 'Untitled'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: C.muted }}>×</button>
        </div>

        <div style={{ overflowY: 'auto', padding: 20 }}>
          {loading ? <div style={{ color: C.muted, padding: 30, textAlign: 'center' }}>Building preview…</div>
           : err ? <div style={{ color: C.red, padding: 16 }}>✗ {err}</div>
           : !data ? null : (
            <>
              {/* Photos */}
              {photos.length > 0 && (
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
                  {photos.slice(0, 12).map((u, i) => <img key={i} src={u} alt="" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 8, flexShrink: 0, border: `1px solid ${C.border}` }} />)}
                </div>
              )}

              {/* Key facts */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <Fact label="Price" value={fmt(data.price)} strong />
                <Fact label="Condition" value={data.condition} />
                <Fact label="Category" value={data.categoryName || data.categoryId || '—'} />
                {data.weightG ? <Fact label="Weight" value={`${(data.weightG/1000).toFixed(2)} kg`} /> : null}
              </div>

              {blankRequired.length > 0 && (
                <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
                  ⚠ {blankRequired.length} required item specific{blankRequired.length === 1 ? '' : 's'} still blank: {blankRequired.map(s => s.name).join(', ')}. eBay may reject or auto-fill these.
                </div>
              )}

              {/* Item specifics */}
              <Group title={`Item specifics (${filled.length}${specifics.length ? ` of ${specifics.length}` : ''} filled)`}>
                {filled.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>None generated yet.</div> : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 18px' }}>
                    {filled.map((s, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '3px 0', borderBottom: `1px solid ${C.bg}` }}>
                        <span style={{ color: C.muted }}>{s.name}{s.required ? ' *' : ''}</span>
                        <span style={{ color: C.text, fontWeight: 600, textAlign: 'right' }}>{s.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Group>

              {/* Fitment */}
              <Group title={`Compatible vehicles (${fitment.length})`}>
                {fitment.length === 0 ? <div style={{ color: C.muted, fontSize: 13 }}>No fitment listed.</div> : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {fitment.slice(0, 40).map((f, i) => (
                      <span key={i} style={{ fontSize: 12, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 8px' }}>
                        {[f.make, f.model, [f.yearFrom, f.yearTo].filter(Boolean).join('–'), f.trim].filter(Boolean).join(' ')}
                      </span>
                    ))}
                  </div>
                )}
              </Group>

              {/* Description */}
              <Group title="Description">
                <div style={{ fontSize: 13, color: C.text, whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto', lineHeight: 1.5, background: '#fafaf9', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12 }}>
                  {data.description || '—'}
                </div>
              </Group>
            </>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: C.muted }}>This is exactly what a publish would send. Corrections are made in the part editor.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={build} disabled={loading} style={{ ...S.btn('secondary'), padding: '8px 14px', fontSize: 13, opacity: loading ? 0.6 : 1 }}>↻ Rebuild</button>
            <button onClick={onClose} style={{ ...S.btn('primary'), padding: '8px 16px', fontSize: 13 }}>Close</button>
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
