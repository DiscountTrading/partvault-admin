import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Reads the ebay_sales mirror — the source of truth for sold revenue + fees.
// Each row is one eBay order line item (keyed on order_id + line_item_id), so
// totals here equal eBay's getOrders exactly. part_id is a best-effort link to
// inventory for COGS/margin and may be null.
const mapRow = r => ({
  id: r.id,
  orderId: r.order_id,
  lineItemId: r.line_item_id,
  legacyItemId: r.legacy_item_id || null,
  sku: r.sku || '',
  title: r.title || '',
  quantity: r.quantity ?? 1,
  soldPrice: +r.sold_price || 0,
  shipping: +r.shipping || 0,
  fees: +r.fees || 0,
  refund: +r.refund || 0,
  shipCost: +r.ship_cost || 0,
  refunded: !!r.refunded,
  soldAt: r.sold_at || null,
  cancelled: !!r.cancelled,
  partId: r.part_id || null,
  source: r.source || 'api',          // 'api' (live sync) or 'csv_orders_report' (history import)
  costs: r.costs || null,             // snapshotted per-category cost for imported history
  feeDetail: r.fee_detail || null,    // per-type eBay fee split { FEE_TYPE: amount }
})

export function useSales(storeId) {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    if (!storeId) { setSales([]); setLoading(false); return }
    setLoading(true)
    const { count } = await sb.from('ebay_sales')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId).eq('cancelled', false)
    const total = count || 0
    const PAGE = 1000
    const all = []
    for (let from = 0; from < total; from += PAGE) {
      const { data, error } = await sb.from('ebay_sales')
        .select('*').eq('store_id', storeId).eq('cancelled', false)
        .order('sold_at', { ascending: false })
        .range(from, Math.min(from + PAGE - 1, total - 1))
      if (error) { setLoading(false); return }
      if (data) all.push(...data)
    }
    setSales(all.map(mapRow))
    setLoading(false)
  }, [storeId])

  useEffect(() => {
    fetch()
    const ch = sb.channel(`admin-sales-${storeId || 'none'}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'ebay_sales', filter: storeId ? `store_id=eq.${storeId}` : undefined },
        () => fetch())
      .subscribe()
    return () => { sb.removeChannel(ch) }
  }, [storeId, fetch])

  return { sales, loading, refetchSales: fetch }
}
