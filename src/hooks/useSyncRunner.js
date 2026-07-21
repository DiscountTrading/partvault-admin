import { useState, useRef, useCallback, useEffect } from 'react'
import { sb } from '../lib/supabase'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

// Progress bands per phase. Import dominates (thousands of listings) so it gets
// the widest band; the rest are quick. `hi` is never quite reached until the next
// phase begins, so the bar keeps moving without ever hitting 100 early.
const PHASE = {
  import:    { lo: 4,  hi: 62, label: 'Importing listings from eBay…' },
  backfill:  { lo: 62, hi: 80, label: 'Importing sold orders…' },
  fees:      { lo: 80, hi: 90, label: 'Importing eBay fees…' },
  reconcile: { lo: 90, hi: 99, label: 'Reconciling with eBay…' },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// App-level driver for the full eBay "Sync now". Lifted OUT of the Settings tab so
// it survives navigating between screens — the App root that hosts this hook never
// unmounts on a tab change, so the progress bar, phase and cancel button keep
// working while the user does something else. (The heavy lifting is server-side and
// resumable via action:cron_sync, so the work itself already continued when the tab
// closed; what was getting lost was the visible progress + the completion refresh.)
//
// Exposes { running, progress, rpm, phase, status, error, lastResult, completedTs,
// start, cancel }. Settings' tachometer and the nav-bar chip both read this, so the
// same run is shown wherever the user happens to be.
export function useSyncRunner({ storeId }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)   // 0–100 displayed (eased)
  const [rpm, setRpm] = useState(0)             // cosmetic activity tacho
  const [phase, setPhase] = useState('')
  const [status, setStatus] = useState('idle')  // idle | running | completed | failed
  const [error, setError] = useState(null)
  const [lastResult, setLastResult] = useState(null)
  const [completedTs, setCompletedTs] = useState(0) // bumps on each finish (for effects)

  const abort = useRef(false)
  const busy = useRef(false)
  const anim = useRef(null)
  const poll = useRef(null)
  const storeRef = useRef(storeId)
  storeRef.current = storeId

  const clearTimers = () => {
    if (anim.current) { clearInterval(anim.current); anim.current = null }
    if (poll.current) { clearInterval(poll.current); poll.current = null }
  }

  // Core driver. `resume` = we detected an already-running server sync (e.g. after a
  // page reload) and are re-attaching the foreground driver to it, so we don't reset
  // the bar to 0 or overwrite an in-flight status.
  const drive = useCallback(async ({ resume = false } = {}) => {
    if (busy.current) return
    const sid = storeRef.current
    if (!sid) return
    busy.current = true
    abort.current = false
    setRunning(true); setStatus('running'); setError(null)
    if (!resume) { setProgress(2); setPhase('Starting sync…') }
    setRpm(55)

    // `target` is the real progress (set by the poller); the animator eases the
    // displayed value toward it every frame so the bar always glides.
    let target = resume ? 4 : 2
    let done = false

    anim.current = setInterval(() => {
      setProgress((prev) => (prev < target ? Math.min(target, prev + Math.max(0.5, (target - prev) * 0.1)) : prev))
      setRpm(done ? 0 : 52 + Math.floor(Math.random() * 26))
    }, 120)

    // Poll the shared sync_runs row (cron_sync writes detail ~every 18s server-side)
    // and translate phase + "X/Y" into a monotonic target.
    poll.current = setInterval(async () => {
      try {
        const { data: run } = await sb.from('sync_runs')
          .select('phase, detail').eq('store_id', sid)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle()
        if (!run) return
        const p = PHASE[run.phase] || { lo: 4, hi: 99, label: 'Working…' }
        const m = /(\d+)\s*\/\s*(\d+)/.exec(run.detail || '')
        const t = (m && +m[2] > 0)
          ? p.lo + (p.hi - p.lo) * Math.min(1, +m[1] / +m[2])
          : Math.min(p.hi - 1, Math.max(target, p.lo) + 1.2)
        target = Math.max(target, t)
        setPhase(`${p.label}${run.detail ? ` · ${run.detail}` : ''}`)
      } catch { /* transient — next tick */ }
    }, 2000)

    try {
      let guard = 0
      while (!done && guard++ < 600) {
        if (abort.current) throw new Error('cancelled')
        let d
        try {
          const res = await fetch(EDGE_FN, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cron_sync', storeId: sid, manual: true }),
          })
          d = await res.json()
        } catch {
          // Network blip — the server-side run is unaffected; keep polling.
          await sleep(3000); continue
        }
        if (d.error) throw new Error(d.error)
        done = d.done === true
        if (d.paused) await sleep(3000)
      }
      target = 100
      await sleep(700) // let the animator glide up to ~100
      setPhase('✓ Sync complete')
      setStatus('completed')
      setLastResult({ at: new Date().toISOString(), ok: true })
      try { localStorage.setItem(`pv_last_manual_sync_${sid}`, new Date().toISOString()) } catch { /* ignore */ }
      try {
        const cur = JSON.parse(localStorage.getItem(`pv_lastrun_${sid}`) || '{}')
        const now = new Date().toISOString()
        cur.import = now; cur.backfill = now; cur.reconcile = now
        localStorage.setItem(`pv_lastrun_${sid}`, JSON.stringify(cur))
      } catch { /* ignore */ }
    } catch (e) {
      if (e.message === 'cancelled') {
        setPhase('Sync cancelled')
        setStatus('idle')
      } else {
        setPhase(`Sync stopped: ${e.message}`)
        setStatus('failed'); setError(e.message)
        setLastResult({ at: new Date().toISOString(), ok: false, error: e.message })
      }
    } finally {
      clearTimers()
      setProgress((prev) => (done ? 100 : prev))
      setRpm(0)
      setRunning(false)
      busy.current = false
      setCompletedTs(Date.now())
    }
  }, [])

  const start = useCallback(() => { if (!busy.current) drive({ resume: false }) }, [drive])
  const cancel = useCallback(() => { abort.current = true }, [])

  // On mount / store change: if the server already has a live sync in flight (a
  // nightly tick, or a run this tab started before a reload), re-attach so the user
  // still sees progress + a working cancel instead of a dead bar.
  useEffect(() => {
    let stop = false
    abort.current = true          // abort any run bound to the previous store
    clearTimers()
    busy.current = false
    setRunning(false); setStatus('idle'); setProgress(0); setRpm(0); setPhase(''); setError(null)
    if (!storeId) return
    ;(async () => {
      try {
        const { data: run } = await sb.from('sync_runs')
          .select('phase, detail, done, updated_at').eq('store_id', storeId)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle()
        if (stop || !run || run.done) return
        // Only adopt a genuinely fresh run (server writes ~every 18s) — anything
        // older is a crashed/finished run we shouldn't keep driving.
        const ageMs = Date.now() - new Date(run.updated_at).getTime()
        if (ageMs < 90000) drive({ resume: true })
      } catch { /* ignore */ }
    })()
    return () => { stop = true }
  }, [storeId, drive])

  // Belt-and-braces cleanup if the whole app tears down.
  useEffect(() => () => { abort.current = true; clearTimers() }, [])

  return { running, progress, rpm, phase, status, error, lastResult, completedTs, start, cancel }
}
