import { useState, useEffect, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'

const mapRow = r => ({
  id: r.id, store_id: r.store_id, sku: r.sku||'', title: r.title||'',
  category: r.category||'', subcategory: r.subcategory||'',
  make: r.make||'', model: r.model||'', year: r.year||'',
  condition: r.condition||'Used – Good',
  description: r.description||'', status: r.status||'in_stock',
  costs: r.costs||{acquisition:0,labour:0,storage:0,packaging:0,postage:0,holding:0},
  list_price: +r.list_price||0, listPrice: +r.list_price||0,
  soldPrice: r.sold_price ? +r.sold_price : null,
  weight: r.weight ? +r.weight : null,
  photos: r.photos||[], partNumber: r.part_number||'',
  notes: r.notes||'', location: r.location||'', acquiredDate: r.acquired_date||null,
  locRow: r.loc_row ?? null, locBay: r.loc_bay ?? null, locShelf: r.loc_shelf ?? null,
  listedDate: r.listed_date||null, soldDate: r.sold_date||null,
  deletedAt: r.deleted_at||null, createdAt: r.created_at,
  car_id: r.car_id||null, source: r.source||null,
  updatedAt: r.updated_at||null,        // optimistic-concurrency stamp

  ai_assessed: r.ai_assessed||false,
  ebayOverrides: r.ebay_overrides||null,
  removalMinutes: r.removal_minutes ?? null,
  marketPrice: r.market_price ?? null,
  marketCount: r.market_count ?? null,
  marketCheckedAt: r.market_checked_at || null,
  shippingCharged: r.shipping_charged ?? null,
})

const mapToRow = p => ({
  sku: p.sku, title: p.title, category: p.category, subcategory: p.subcategory,
  make: p.make, model: p.model, year: p.year, condition: p.condition,
  description: p.description, status: p.status, costs: p.costs,
  list_price: +p.listPrice||+p.list_price||0,
  sold_price: p.soldPrice ? +p.soldPrice : null,
  weight: p.weight ? +p.weight : null, photos: p.photos||[],
  part_number: p.partNumber||'',
  notes: p.notes||'', location: p.location||null, acquired_date: p.acquiredDate||null,
  loc_row: p.locRow===''||p.locRow==null ? null : +p.locRow,
  loc_bay: p.locBay===''||p.locBay==null ? null : +p.locBay,
  loc_shelf: p.locShelf===''||p.locShelf==null ? null : +p.locShelf,
  listed_date: p.listedDate||null, sold_date: p.soldDate||null,
  deleted_at: p.deletedAt||null, car_id: p.car_id||null,
  ai_assessed: p.ai_assessed||false,
  removal_minutes: p.removalMinutes ?? null,
  shipping_charged: p.shippingCharged ?? null,
})

export function useParts(storeId) {
  const [parts, setParts] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState('connecting')
  const [totalCount, setTotalCount] = useState(0)
  const channelRef = useRef(null)

  const fetch = useCallback(async () => {
    // No active store yet → nothing to show. (Prevents an unscoped query that
    // would otherwise return parts from every store the user is a member of.)
    if (!storeId) {
      setParts([])
      setTotalCount(0)
      setLoading(false)
      return
    }

    const { count, error: countErr } = await sb
      .from('parts')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .is('deleted_at', null)
    if (countErr) {
      console.error('Parts count error:', countErr)
      setSyncStatus('error')
      setLoading(false)
      return
    }
    setTotalCount(count || 0)

    const PAGE_SIZE_FETCH = 1000
    const totalRows = count || 0
    const allRows = []
    for (let from = 0; from < totalRows; from += PAGE_SIZE_FETCH) {
      const to = Math.min(from + PAGE_SIZE_FETCH - 1, totalRows - 1)
      const { data, error } = await sb
        .from('parts')
        .select('*')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(from, to)
      if (error) {
        console.error('Parts fetch error (page):', error)
        setSyncStatus('error')
        setLoading(false)
        return
      }
      if (data) allRows.push(...data)
    }
    setParts(allRows.map(mapRow))
    setSyncStatus('live')
    setLoading(false)
  }, [storeId])

  useEffect(() => {
    setLoading(true)
    fetch()
    // Scope realtime to this store so another store's edits don't trigger refetches
    channelRef.current = sb.channel(`admin-parts-realtime-${storeId || 'none'}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'parts', filter: storeId ? `store_id=eq.${storeId}` : undefined },
        () => { fetch() })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setSyncStatus('live')
        if (status === 'CHANNEL_ERROR') setSyncStatus('error')
      })
    return () => {
      if (channelRef.current) sb.removeChannel(channelRef.current)
    }
  }, [storeId, fetch])

  const addPart = async p => {
    const { data: { user } } = await sb.auth.getUser()
    const { data, error } = await sb.from('parts').insert({
      ...mapToRow(p),
      store_id: storeId,
      created_by: user?.id,
    }).select().single()
    if (!error) { setParts(ps => [mapRow(data), ...ps]); return mapRow(data) }
    throw error
  }

  const editPart = async p => {
    // Optimistic concurrency: only update if the row hasn't changed since it was
    // loaded. If updated_at no longer matches, someone else saved first → reject
    // (don't silently overwrite their change).
    let q = sb.from('parts').update(mapToRow(p)).eq('id', p.id)
    if (p.updatedAt) q = q.eq('updated_at', p.updatedAt)
    const { data, error } = await q.select()
    if (error) throw error
    if (!data || !data.length) { const e = new Error('Part was changed by someone else'); e.code = 'STALE'; throw e }
    setParts(ps => ps.map(x => x.id===p.id ? mapRow(data[0]) : x))
  }

  const softDelete = async id => {
    const now = new Date().toISOString()
    await sb.from('parts').update({ deleted_at: now }).eq('id', id)
    setParts(ps => ps.filter(p => p.id !== id))
  }

  const softDeleteCar = async (carId, partIds) => {
    const now = new Date().toISOString()
    if (partIds.length > 0) {
      await sb.from('parts').update({ deleted_at: now }).in('id', partIds)
    }
    if (carId) {
      await sb.from('cars').update({ deleted_at: now, status: 'deleted' }).eq('id', carId)
    }
    setParts(ps => ps.filter(p => !partIds.includes(p.id)))
  }

  return { parts, loading, syncStatus, totalCount, addPart, editPart, softDelete, softDeleteCar, refetch: fetch }
}
