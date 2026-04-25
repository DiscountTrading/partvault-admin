import { useState, useEffect, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'

const PAGE_SIZE = 100

const mapRow = r => ({
  id: r.id, sku: r.sku||'', title: r.title||'', category: r.category||'',
  subcategory: r.subcategory||'', make: r.make||'', model: r.model||'',
  year: r.year||'', condition: r.condition||'Used – Good',
  description: r.description||'', status: r.status||'In Stock',
  costs: r.costs||{acquisition:0,labour:0,storage:0,packaging:0,postage:0,holding:0},
  list_price: +r.list_price||0, listPrice: +r.list_price||0,
  soldPrice: r.sold_price ? +r.sold_price : null,
  weight: r.weight ? +r.weight : null,
  photos: r.photos||[], partNumber: r.part_number||'',
  ebayItemId: r.ebay_item_id||'', ebayCategoryId: r.ebay_category_id||'',
  shippingOption: r.shipping_option||'Standard Post',
  notes: r.notes||'', acquiredDate: r.acquired_date||null,
  listedDate: r.listed_date||null, soldDate: r.sold_date||null,
  deletedAt: r.deleted_at||null, createdAt: r.created_at,
  session_id: r.session_id||null, car_id: r.car_id||null,
  sync_status: r.sync_status||'synced',
  ai_assessed: r.ai_assessed||false,
})

const mapToRow = p => ({
  sku: p.sku, title: p.title, category: p.category, subcategory: p.subcategory,
  make: p.make, model: p.model, year: p.year, condition: p.condition,
  description: p.description, status: p.status, costs: p.costs,
  list_price: +p.listPrice||+p.list_price||0,
  sold_price: p.soldPrice ? +p.soldPrice : null,
  weight: p.weight ? +p.weight : null, photos: p.photos||[],
  part_number: p.partNumber||'', ebay_item_id: p.ebayItemId||'',
  ebay_category_id: p.ebayCategoryId||'',
  shipping_option: p.shippingOption||'Standard Post',
  notes: p.notes||'', acquired_date: p.acquiredDate||null,
  listed_date: p.listedDate||null, sold_date: p.soldDate||null,
  deleted_at: p.deletedAt||null,
  ai_assessed: p.ai_assessed||false,
})

export function useParts() {
  const [parts, setParts] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState('connecting')
  const [totalCount, setTotalCount] = useState(0)
  const channelRef = useRef(null)

  const fetch = useCallback(async () => {
    const { data, error, count } = await sb
      .from('parts')
      .select('*', { count: 'exact' })
      .neq('status', 'Deleted')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(10000) // v2.3.3: bumped from 2000; proper count-only query refactor scheduled
    if (!error && data) {
      setParts(data.map(mapRow))
      setTotalCount(count || data.length)
      setSyncStatus('live')
    } else {
      console.error('Parts fetch error:', error)
      setSyncStatus('error')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetch()
    channelRef.current = sb.channel('admin-parts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'parts' }, () => {
        fetch()
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setSyncStatus('live')
        if (status === 'CHANNEL_ERROR') setSyncStatus('error')
      })
    return () => {
      if (channelRef.current) sb.removeChannel(channelRef.current)
    }
  }, [])

  const addPart = async p => {
    const { data: { user } } = await sb.auth.getUser()
    const { data, error } = await sb.from('parts').insert({ ...mapToRow(p), user_id: user?.id }).select().single()
    if (!error) { setParts(ps => [mapRow(data), ...ps]); return mapRow(data) }
    throw error
  }

  const editPart = async p => {
    const { error } = await sb.from('parts').update(mapToRow(p)).eq('id', p.id)
    if (!error) setParts(ps => ps.map(x => x.id===p.id ? {...x,...p} : x))
    else throw error
  }

  const softDelete = async id => {
    const now = new Date().toISOString()
    await sb.from('parts').update({ status: 'Deleted', deleted_at: now }).eq('id', id)
    setParts(ps => ps.filter(p => p.id !== id))
  }

  const softDeleteCar = async (carId, partIds) => {
    const now = new Date().toISOString()
    if (partIds.length > 0) {
      await sb.from('parts').update({ status: 'Deleted', deleted_at: now }).in('id', partIds)
    }
    if (carId) {
      await sb.from('cars').update({ deleted_at: now, status: 'deleted' }).eq('id', carId)
    }
    setParts(ps => ps.filter(p => !partIds.includes(p.id)))
  }

  return { parts, loading, syncStatus, totalCount, addPart, editPart, softDelete, softDeleteCar, refetch: fetch }
}