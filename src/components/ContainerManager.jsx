import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'
import { warehouseConfig, formatGridLoc } from '../lib/warehouse'
import { printContainerLabels, DEFAULT_LABELS } from '../lib/labels'

// Admin manager for storage containers (tubs/buckets). Create, name, park at a
// grid home, print the QR the mobile scanner reads, and retire. Store-scoped.
export default function ContainerManager({ storeId, warehouse, labels = DEFAULT_LABELS }) {
  const wc = warehouseConfig(warehouse)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!storeId) return
    setLoading(true); setErr('')
    const { data, error } = await sb.from('containers')
      .select('*').eq('store_id', storeId).is('deleted_at', null).order('code')
    if (error) setErr(error.message); else setRows(data || [])
    setLoading(false)
  }, [storeId])
  useEffect(() => { load() }, [load])

  // Suggest the next code: <PREFIX>-001 from the container name + highest suffix.
  const nextCode = () => {
    const prefix = (wc.containerLabel || 'Bucket').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'BIN'
    let max = 0
    for (const r of rows) {
      const m = /(\d+)\s*$/.exec(r.code || '')
      if (m) max = Math.max(max, +m[1])
    }
    return `${prefix}-${String(max + 1).padStart(3, '0')}`
  }

  const addOne = async () => {
    setBusy(true); setErr('')
    const { data, error } = await sb.from('containers')
      .insert({ store_id: storeId, code: nextCode(), kind: (wc.containerLabel || 'bucket').toLowerCase() })
      .select('*').single()
    setBusy(false)
    if (error) { setErr(error.message); return }
    setRows(r => [...r, data].sort((a, b) => (a.code || '').localeCompare(b.code || '')))
  }

  const patch = async (id, fields) => {
    setRows(r => r.map(x => x.id === id ? { ...x, ...fields } : x)) // optimistic
    const { error } = await sb.from('containers').update(fields).eq('id', id)
    if (error) { setErr(error.message); load() }
  }

  const remove = async (ct) => {
    if (!confirm(`Retire ${ct.code}? Parts in it keep their last known spot but lose the ${wc.containerLabel.toLowerCase()} tag.`)) return
    await sb.from('containers').update({ deleted_at: new Date().toISOString() }).eq('id', ct.id)
    await sb.from('parts').update({ container_id: null }).eq('container_id', ct.id)
    setRows(r => r.filter(x => x.id !== ct.id))
  }

  const gridOn = wc.rows > 0 && wc.bays > 0
  const axisSelect = (ct, key, count) => (
    <select style={{ ...S.select, padding: '6px 8px', minWidth: 58 }} value={ct[key] ?? ''}
      onChange={e => patch(ct.id, { [key]: e.target.value === '' ? null : +e.target.value })}>
      <option value="">—</option>
      {Array.from({ length: Math.max(0, count | 0) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
    </select>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button style={{ ...S.btn(), padding: '8px 16px' }} onClick={addOne} disabled={busy}>＋ Add {wc.containerLabel.toLowerCase()}</button>
        {rows.length > 0 && (
          <button style={{ ...S.btn('secondary'), padding: '8px 16px' }}
            onClick={() => printContainerLabels(rows, labels, warehouse)}>🏷️ Print all QR labels ({rows.length})</button>
        )}
        <span style={{ fontSize: 12, color: C.muted }}>{rows.length} {rows.length === 1 ? wc.containerLabel.toLowerCase() : wc.containerLabel.toLowerCase() + 's'}</span>
      </div>
      {err && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{err}</div>}
      {loading ? (
        <div style={{ fontSize: 13, color: C.muted }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: C.muted }}>No {wc.containerLabel.toLowerCase()}s yet — add one, print its QR, and stick it on the tub. Then scan parts into it from the phone.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: C.muted, fontSize: 11 }}>
                <th style={{ padding: '4px 8px 8px 0' }}>Code</th>
                <th style={{ padding: '4px 8px 8px 0' }}>Label (optional)</th>
                {gridOn && <th style={{ padding: '4px 8px 8px 0' }} colSpan={3}>Home spot (where the {wc.containerLabel.toLowerCase()} lives)</th>}
                <th style={{ padding: '4px 0 8px 0' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(ct => (
                <tr key={ct.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: '6px 8px 6px 0' }}>
                    <input style={{ ...S.input, padding: '6px 8px', minWidth: 90, fontWeight: 700 }} value={ct.code || ''}
                      onChange={e => setRows(r => r.map(x => x.id === ct.id ? { ...x, code: e.target.value } : x))}
                      onBlur={e => patch(ct.id, { code: e.target.value.trim() })} />
                  </td>
                  <td style={{ padding: '6px 8px 6px 0' }}>
                    <input style={{ ...S.input, padding: '6px 8px', minWidth: 140 }} value={ct.name || ''} placeholder="e.g. Corolla fronts"
                      onChange={e => setRows(r => r.map(x => x.id === ct.id ? { ...x, name: e.target.value } : x))}
                      onBlur={e => patch(ct.id, { name: e.target.value.trim() || null })} />
                  </td>
                  {gridOn && <>
                    <td style={{ padding: '6px 6px 6px 0' }}><label style={{ fontSize: 10, color: C.muted, display: 'block' }}>{wc.rowLabel}</label>{axisSelect(ct, 'loc_row', wc.rows)}</td>
                    <td style={{ padding: '6px 6px 6px 0' }}><label style={{ fontSize: 10, color: C.muted, display: 'block' }}>{wc.bayLabel}</label>{axisSelect(ct, 'loc_bay', wc.bays)}</td>
                    <td style={{ padding: '6px 8px 6px 0' }}><label style={{ fontSize: 10, color: C.muted, display: 'block' }}>{wc.shelfLabel}</label>{axisSelect(ct, 'loc_shelf', wc.shelves)}</td>
                  </>}
                  <td style={{ padding: '6px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={{ ...S.btn('secondary'), padding: '5px 10px', fontSize: 12, marginRight: 6 }}
                      title="Print this QR label" onClick={() => printContainerLabels([ct], labels, warehouse)}>🏷️</button>
                    <button style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 12 }}
                      onClick={() => remove(ct)}>Retire</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
