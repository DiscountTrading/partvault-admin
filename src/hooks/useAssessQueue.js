import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

const AI_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess'
const EBAY_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

// Extract a usable URL from a stored photo value (string, JSON string, or object).
function urlFrom(v) {
  if (!v) return null
  if (typeof v === 'object') return v.url || v.ebay_url || null
  try { const o = JSON.parse(v); return o.url || o.ebay_url || v } catch { return v }
}

async function authHeaders() {
  const { data: { session } } = await sb.auth.getSession()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }
}

// Passing partId makes the edge fn PERSIST the full assessment via the service
// role, so results save with no editor open — that's what makes this a true
// background queue.
async function analysePart({ photoUrls, carId, partId }, car, storeId) {
  const res = await fetch(AI_FN, { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ storeId, photoUrls, car, carId, partId }) })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'AI assessment failed')
  return data
}

// Generate the eBay item specifics + fitment for a part and PERSIST them onto the
// part (persist:true → ebay_specifics), so the part is listing-ready and the
// preview panel opens instantly. Same call/result the eBay preview panel uses.
async function generateSpecifics(partId, storeId) {
  const res = await fetch(EBAY_FN, { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ action: 'preview_listing', storeId, partId, persist: true }) })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'Specifics generation failed')
  return data
}

// App-level background pipeline. Lives at the app root (not inside the Inventory
// tab) so parts created ANYWHERE — the admin form, mobile capture, an import —
// are made listing-ready silently regardless of which tab is open. Two steps per
// part, newest first, one at a time (the edge fns' 429/529 back-off paces it):
//   1. AI assessment (title/category/condition/description/price/…)
//   2. eBay specifics + fitment (the step that used to be a manual "eBay preview")
// Pausable; each part is tried once per session (a refresh re-tries leftovers).
export function useAssessQueue({ storeId, parts, cars, refetch }) {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [paused, setPaused] = useState(() => { try { return localStorage.getItem('pv_assess_paused') === '1' } catch { return false } })
  const busy = useRef(false)
  const abort = useRef(false)
  const tried = useRef(new Set())

  const partUrlsOf = (p) => (p.photos || []).map(urlFrom).filter(Boolean)
  // A part needs work if it's in stock with a photo and is missing its assessment
  // OR its eBay specifics.
  const needWork = useMemo(
    () => (parts || []).filter(p => p.status === 'in_stock' && partUrlsOf(p).length && (!p.ai_assessed || !p.ebaySpecifics)),
    [parts])

  const run = useCallback(async () => {
    if (busy.current || paused) return
    const queue = needWork
      .filter(p => !tried.current.has(p.id))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) // newest first
    if (!queue.length) return
    busy.current = true; abort.current = false
    setRunning(true); setTotal(queue.length); setDone(0)
    let n = 0
    for (const p of queue) {
      if (abort.current) break
      tried.current.add(p.id)
      // Step 1 — assessment (only if not already assessed).
      let assessedOk = p.ai_assessed
      if (!assessedOk) {
        try {
          const car = cars?.find(c => c.id === p.car_id)
          await analysePart({ photoUrls: partUrlsOf(p).slice(0, 4), carId: car?.id, partId: p.id }, car || p, storeId)
          assessedOk = true
        } catch (_) { /* leave for a later retry; skip specifics this round */ }
      }
      // Step 2 — eBay specifics (needs the assessment done first for a good category).
      if (assessedOk && !p.ebaySpecifics && !abort.current) {
        try { await generateSpecifics(p.id, storeId) } catch (_) { /* best effort */ }
      }
      setDone(++n)
      if (n % 3 === 0) refetch?.() // surface progress
    }
    busy.current = false; setRunning(false)
    refetch?.()
  }, [needWork, paused, cars, storeId, refetch])

  // Auto-start whenever something needs work (unless paused). The busy/tried
  // guards stop it re-triggering itself as refetch updates `parts`.
  useEffect(() => {
    if (paused || busy.current) return
    if (needWork.some(p => !tried.current.has(p.id))) run()
  }, [needWork, paused, storeId, run])

  // New store → start fresh and abort any in-flight run for the old store.
  useEffect(() => { tried.current = new Set(); abort.current = true }, [storeId])

  const togglePaused = () => setPaused(v => {
    const nv = !v
    try { localStorage.setItem('pv_assess_paused', nv ? '1' : '0') } catch { /* ignore */ }
    if (nv) abort.current = true
    return nv
  })

  return { running, done, total, paused, togglePaused, remaining: needWork.length }
}
