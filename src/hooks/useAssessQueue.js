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

// Generate + PERSIST the eBay item specifics/fitment (persist:true → ebay_specifics).
// Returns { persisted } — false means the save couldn't land (ebay_specifics column
// missing → migration not run), which the queue treats as blocked rather than retrying.
async function generateSpecifics(partId, storeId) {
  const res = await fetch(EBAY_FN, { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ action: 'preview_listing', storeId, partId, persist: true }) })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'Specifics generation failed')
  return data
}

const MAX_ROUNDS = 20            // safety cap on consecutive auto-retry rounds
const DEFAULT_PART_MS = 9000     // ETA seed before we've measured a real part

// App-level background pipeline. Lives at the app root (not inside the Inventory
// tab) so parts created ANYWHERE — the admin form, mobile capture, an import —
// are made listing-ready silently regardless of which tab is open. Two steps per
// part, newest first, one at a time (the edge fns' 429/529 back-off paces it):
//   1. AI assessment (title/category/condition/description/price/…)
//   2. eBay specifics + fitment (the step that used to be a manual "eBay preview")
// Anything that doesn't complete (rate limit, transient error) is auto-retried
// with a growing back-off instead of stalling. If the specifics step can't save
// (ebay_specifics migration not run), the queue reports `blocked` and stops
// hammering. Pausable.
export function useAssessQueue({ storeId, parts, cars, refetch }) {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [paused, setPaused] = useState(() => { try { return localStorage.getItem('pv_assess_paused') === '1' } catch { return false } })
  const [etaMs, setEtaMs] = useState(null)      // estimated ms left in the current run
  const [retryAt, setRetryAt] = useState(null)  // ms timestamp of the next auto-retry, or null
  const [blocked, setBlocked] = useState(null)  // reason string when a step can't complete
  const [, setTick] = useState(0)               // drives the retry countdown re-render

  const busy = useRef(false)
  const abort = useRef(false)
  const tried = useRef(new Set())
  const durations = useRef([])   // ms per completed part (rolling, for the ETA)
  const round = useRef(0)
  const retryTimer = useRef(null)
  const seen = useRef(new Set())        // part ids we've ever queued (to reset the round cap on genuinely new work)
  const needWorkRef = useRef([])

  const partUrlsOf = (p) => (p.photos || []).map(urlFrom).filter(Boolean)
  // A part needs work if it's in stock with a photo and is missing its assessment
  // OR its eBay specifics.
  const needWork = useMemo(
    () => (parts || []).filter(p => p.status === 'in_stock' && partUrlsOf(p).length && (!p.ai_assessed || !p.ebaySpecifics)),
    [parts])
  needWorkRef.current = needWork

  const avgMs = () => durations.current.length ? durations.current.reduce((a, b) => a + b, 0) / durations.current.length : DEFAULT_PART_MS

  const run = useCallback(async () => {
    if (busy.current || paused) return
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    setRetryAt(null)
    const queue = needWork
      .filter(p => !tried.current.has(p.id))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))) // newest first
    if (!queue.length) return
    busy.current = true; abort.current = false
    setRunning(true); setTotal(queue.length); setDone(0); setEtaMs(Math.round(queue.length * avgMs()))
    let n = 0, incomplete = 0, sawBlock = false
    for (const p of queue) {
      if (abort.current) break
      tried.current.add(p.id)
      const t0 = Date.now()
      let assessedOk = p.ai_assessed
      if (!assessedOk) {
        try {
          const car = cars?.find(c => c.id === p.car_id)
          await analysePart({ photoUrls: partUrlsOf(p).slice(0, 4), carId: car?.id, partId: p.id }, car || p, storeId)
          assessedOk = true
        } catch (_) { /* transient — retried next round */ }
      }
      let specificsOk = !!p.ebaySpecifics
      if (assessedOk && !specificsOk && !abort.current) {
        try {
          const d = await generateSpecifics(p.id, storeId)
          if (d && d.persisted === false) sawBlock = true   // column missing → can't ever land
          else specificsOk = true
        } catch (_) { /* transient — retried next round */ }
      }
      if (!assessedOk || !specificsOk) incomplete++
      durations.current.push(Date.now() - t0)
      if (durations.current.length > 20) durations.current.shift()
      n++; setDone(n); setEtaMs(Math.round((queue.length - n) * avgMs()))
      if (n % 3 === 0) refetch?.()
    }
    busy.current = false; setRunning(false); setEtaMs(null)
    refetch?.()

    if (abort.current) return
    if (sawBlock) { setBlocked('ebay-specifics'); return }  // stop — retrying won't help until the migration runs
    setBlocked(null)
    // Work still left over (transient failures) → schedule an auto-retry with back-off.
    if (incomplete > 0 && round.current < MAX_ROUNDS) {
      const delay = Math.min(120000, Math.round(15000 * Math.pow(1.6, round.current)))
      round.current += 1
      setRetryAt(Date.now() + delay)
      retryTimer.current = setTimeout(() => {
        setRetryAt(null); retryTimer.current = null
        if (needWorkRef.current.length) { tried.current = new Set(); run() }
      }, delay)
    }
  }, [needWork, paused, cars, storeId, refetch])

  // Auto-start when there's untried work (and not paused / not mid-retry). New part
  // ids reset the retry-round cap so fresh work always gets a full set of attempts.
  useEffect(() => {
    if (paused || busy.current || retryAt != null) return
    const fresh = needWork.filter(p => !seen.current.has(p.id))
    if (fresh.length) { fresh.forEach(p => seen.current.add(p.id)); round.current = 0 }
    if (needWork.some(p => !tried.current.has(p.id))) run()
  }, [needWork, paused, retryAt, storeId, run])

  // Tick every second while a retry is counting down, so the countdown updates.
  useEffect(() => {
    if (retryAt == null) return
    const iv = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(iv)
  }, [retryAt])

  // New store → start fresh and abort any in-flight run for the old store.
  useEffect(() => {
    tried.current = new Set(); seen.current = new Set(); durations.current = []; round.current = 0
    abort.current = true; setBlocked(null); setRetryAt(null)
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
  }, [storeId])

  const togglePaused = () => setPaused(v => {
    const nv = !v
    try { localStorage.setItem('pv_assess_paused', nv ? '1' : '0') } catch { /* ignore */ }
    if (nv) { abort.current = true; if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null } setRetryAt(null) }
    else { tried.current = new Set(); round.current = 0 }  // resume → give leftovers a fresh attempt
    return nv
  })

  const retrySec = retryAt != null ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : null
  return { running, done, total, paused, togglePaused, remaining: needWork.length, etaMs, retrySec, blocked }
}
