import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

const AI_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess'

// Extract a usable URL from a stored photo value (string, JSON string, or object).
function urlFrom(v) {
  if (!v) return null
  if (typeof v === 'object') return v.url || v.ebay_url || null
  try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v }
}

// Passing partId makes the edge fn PERSIST the full assessment via the service
// role, so results save with no editor open — that's what makes this a true
// background queue.
async function analysePart({ photoUrls, carId, partId }, car, storeId) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(AI_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ storeId, photoUrls, car, carId, partId }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'AI assessment failed')
  return data
}

// App-level background AI assessment queue. Lives at the app root (not inside the
// Inventory tab) so parts created ANYWHERE — the admin form, mobile capture, an
// import — get assessed silently regardless of which tab is open. Works through
// in-stock, un-assessed parts that have a photo, newest first, one at a time. The
// edge fn's 429/529 back-off paces it under the Anthropic rate limit. Pausable;
// each part is tried once per session (a refresh re-tries any still-unassessed).
export function useAssessQueue({ storeId, parts, cars, refetch }) {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [paused, setPaused] = useState(() => { try { return localStorage.getItem('pv_assess_paused') === '1' } catch { return false } })
  const busy = useRef(false)
  const abort = useRef(false)
  const tried = useRef(new Set())

  const partUrlsOf = (p) => (p.photos || []).map(urlFrom).filter(Boolean)
  const needAssess = useMemo(
    () => (parts || []).filter(p => p.status === 'in_stock' && !p.ai_assessed && partUrlsOf(p).length),
    [parts])

  const run = useCallback(async () => {
    if (busy.current || paused) return
    const queue = needAssess
      .filter(p => !tried.current.has(p.id))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) // newest first
    if (!queue.length) return
    busy.current = true; abort.current = false
    setRunning(true); setTotal(queue.length); setDone(0)
    let n = 0
    for (const p of queue) {
      if (abort.current) break
      tried.current.add(p.id)
      try {
        const car = cars?.find(c => c.id === p.car_id)
        await analysePart({ photoUrls: partUrlsOf(p).slice(0, 4), carId: car?.id, partId: p.id }, car || p, storeId)
      } catch (_) { /* skip this part, keep going */ }
      setDone(++n)
      if (n % 4 === 0) refetch?.() // surface ✅s progressively
    }
    busy.current = false; setRunning(false)
    refetch?.()
  }, [needAssess, paused, cars, storeId, refetch])

  // Auto-start whenever something needs assessing (unless paused). The busy/tried
  // guards stop it re-triggering itself as refetch updates `parts`.
  useEffect(() => {
    if (paused || busy.current) return
    if (needAssess.some(p => !tried.current.has(p.id))) run()
  }, [needAssess, paused, storeId, run])

  // New store → start fresh and abort any in-flight run for the old store.
  useEffect(() => { tried.current = new Set(); abort.current = true }, [storeId])

  const togglePaused = () => setPaused(v => {
    const nv = !v
    try { localStorage.setItem('pv_assess_paused', nv ? '1' : '0') } catch { /* ignore */ }
    if (nv) abort.current = true
    return nv
  })

  return { running, done, total, paused, togglePaused, remaining: needAssess.length }
}
