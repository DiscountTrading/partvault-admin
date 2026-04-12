import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'

function downloadCSV(csvContent, filename) {
  const uri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent)
  const a = document.createElement('a')
  a.setAttribute('href', uri); a.setAttribute('download', filename)
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
}

export default function CSVHistory({ storeId }) {
  const [exports, setExports] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [toast, setToast] = useState('')

  const load = useCallback(async () => {
    if (!storeId) { setLoading(false); return }
    const { data } = await sb.from('csv_exports').select('*').eq('store_id', storeId).is('deleted_at', null).order('created_at', { ascending: false })
    setExports(data || [])
    setLoading(false)
  }, [storeId])

  useEffect(() => {
    load()
    if (!storeId) return
    const ch = sb.channel('admin-csv-history-v2')
      .on('postgres_changes', { event:'*', schema:'public', table:'csv_exports', filter:`store_id=eq.${storeId}` }, load)
      .subscribe()
    return () => sb.removeChannel(ch)
  }, [load])

  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  const redownload = ex => {
    downloadCSV(ex.csv_data, ex.filename)
    showToast('Downloaded: ' + ex.filename)
  }

  const saveEditName = async ex => {
    if (!editName.trim()) return
    await sb.from('csv_exports').update({ filename: editName.trim() }).eq('id', ex.id)
    setExports(es => es.map(e => e.id===ex.id ? {...e, filename:editName.trim()} : e))
    setEditingId(null); setEditName(''); showToast('Renamed ✓')
  }

  const deleteExport = async ex => {
    if (!window.confirm(`Delete export "${ex.filename}"?\n\nHistory record only — parts not affected.`)) return
    await sb.from('csv_exports').update({ deleted_at: new Date().toISOString() }).eq('id', ex.id)
    setExports(es => es.filter(e => e.id !== ex.id))
    showToast('Deleted ✓')
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, paddingBottom:16, borderBottom:`1px solid ${C.border}` }}>
        <h2 style={S.h1}>📄 CSV Export History</h2>
        <button style={S.btn('secondary')} onClick={load}>↻ Refresh</button>
      </div>
      {toast && <div style={{ background:C.green, color:'#fff', padding:'10px 18px', borderRadius:8, marginBottom:16, fontSize:14, fontWeight:600 }}>{toast}</div>}
      {!storeId && <div style={{ color:C.muted, padding:40, textAlign:'center' }}>No store linked.</div>}
      {loading && <div style={{ color:C.muted, padding:40, textAlign:'center' }}>Loading...</div>}
      {!loading && !exports.length && (
        <div style={{ ...S.card, textAlign:'center', padding:60 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>📄</div>
          <div style={{ fontSize:18, fontWeight:700, color:C.text, marginBottom:8 }}>No exports yet</div>
          <div style={{ color:C.muted }}>CSV exports from the mobile app will appear here.</div>
        </div>
      )}
      {exports.map(ex => (
        <div key={ex.id} style={{ ...S.card, marginBottom:12 }}>
          {editingId === ex.id ? (
            <div>
              <label style={S.label}>Filename</label>
              <input style={{ ...S.input, marginBottom:12 }} value={editName} onChange={e=>setEditName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&saveEditName(ex)} autoFocus />
              <div style={{ display:'flex', gap:10 }}>
                <button style={{ ...S.btn('green'), padding:'10px 24px' }} onClick={()=>saveEditName(ex)}>Save</button>
                <button style={S.btn('secondary')} onClick={()=>{setEditingId(null);setEditName('')}}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
                <div>
                  <div style={{ fontWeight:700, fontSize:15, color:C.text, marginBottom:4 }}>{ex.filename}</div>
                  <div style={{ fontSize:13, color:C.muted }}>
                    {new Date(ex.created_at).toLocaleString('en-AU', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}
                    &nbsp;·&nbsp; {ex.part_count} part{ex.part_count!==1?'s':''}
                  </div>
                </div>
                <span style={{ ...S.pill(C.green), fontSize:12 }}>CSV</span>
              </div>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                <button style={{ ...S.btn('blue'), padding:'8px 18px', fontSize:13 }} onClick={()=>redownload(ex)}>⬇ Download</button>
                <button style={{ ...S.btn('secondary'), padding:'8px 18px', fontSize:13 }} onClick={()=>{setEditingId(ex.id);setEditName(ex.filename)}}>✏ Rename</button>
                <button style={{ ...S.btn('secondary'), padding:'8px 18px', fontSize:13 }} onClick={()=>setExpandedId(expandedId===ex.id?null:ex.id)}>
                  {expandedId===ex.id?'▲ Hide':'▼ Show'} parts
                </button>
                <button style={{ ...S.btn('danger'), padding:'8px 18px', fontSize:13 }} onClick={()=>deleteExport(ex)}>🗑 Delete</button>
              </div>
              {expandedId===ex.id && (
                <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${C.border}` }}>
                  <div style={{ fontSize:12, color:C.muted, fontWeight:600, marginBottom:8, textTransform:'uppercase' }}>Included Parts ({(ex.part_ids||[]).length})</div>
                  <div style={{ fontSize:13, color:C.muted, fontFamily:'monospace' }}>
                    {(ex.part_ids||[]).map(id=>(
                      <div key={id} style={{ padding:'4px 0', borderBottom:`1px solid ${C.border}` }}>…{id.slice(-20)}</div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
