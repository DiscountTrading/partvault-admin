import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Local fulfilment state per sale (Collected/Packed/Delivered/Feedback + an
// optional manual Posted override) — see the 20260707_sale_workflow and
// 20260708_sale_posted migrations. Keyed by sale_id (ebay_sales.id). Posted is
// primarily read from the sale's fulfillment_status; posted_at here only lets the
// app mark it shipped before eBay confirms. Both admin and mobile write this
// table, so changes stream in via realtime.
export function useSaleWorkflow(storeId) {
  const [wf, setWf] = useState({})        // sale_id -> row

  const load = useCallback(async () => {
    if (!storeId) { setWf({}); return }
    const { data, error } = await sb.from('sale_workflow').select('*').eq('store_id', storeId)
    // Table may not exist yet (migration not run) — fail soft to an empty map so the
    // Sales tab still renders; stage buttons just won't persist until it's applied.
    if (error) { setWf({}); return }
    setWf(Object.fromEntries((data || []).map(r => [r.sale_id, r])))
  }, [storeId])

  // Set/clear a stage on one sale. Optimistic; upserts the whole row on sale_id.
  const setStage = useCallback(async (saleId, patch) => {
    const { data: { user } } = await sb.auth.getUser()
    setWf(w => ({ ...w, [saleId]: { sale_id: saleId, store_id: storeId, ...(w[saleId] || {}), ...patch } }))
    const row = { sale_id: saleId, store_id: storeId, ...patch, updated_at: new Date().toISOString(), updated_by: user?.id || null }
    const { error } = await sb.from('sale_workflow').upsert(row, { onConflict: 'sale_id' })
    if (error) load() // revert to server truth on failure
  }, [storeId, load])

  useEffect(() => {
    load()
    let t
    const ch = sb.channel(`admin-workflow-${storeId || 'none'}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'sale_workflow', filter: storeId ? `store_id=eq.${storeId}` : undefined },
        () => { clearTimeout(t); t = setTimeout(load, 800) })
      .subscribe()
    return () => { clearTimeout(t); sb.removeChannel(ch) }
  }, [storeId, load])

  return { wf, setStage, refetchWorkflow: load }
}
