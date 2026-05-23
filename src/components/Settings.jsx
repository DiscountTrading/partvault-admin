import { useState, useEffect, useRef } from 'react'
import { C, S, APP_VERSION } from '../lib/constants'
import { sb } from '../lib/supabase'

const DEFAULT_FOOTER = `At Cloud9 Auto Parts, we aim to make your buying experience as simple and reliable as possible. All photos shown are of the exact part you will receive, no stock images. We clearly list the compatible models and year ranges in each title, but we always recommend double checking fitment by comparing photos, part numbers, and your own research.
All parts are genuine used OEM components unless stated otherwise. As they are pre-owned, some items may show minor wear, which we highlight clearly in the photos. Everything we have in stock is listed here on our eBay store.
Some parts, such as ECUs or stereos, may require a security code from the vehicle manufacturer. Steering wheels are sold without airbags due to shipping restrictions.
Shipping:
All items are posted first thing each morning. Orders placed after the daily dispatch time will be shipped the following morning, and tracking will be provided through eBay once your order is on its way.
Please note that we do not offer local pickup.
If you have any questions, feel free to send a message. I'll always do my best to help and ensure you're completely satisfied with your purchase.`

const DEFAULT_AI_SETTINGS = {
  includeMake: true,
  includeModel: true,
  includeSeries: true,
  includeYearRange: true,
  descriptionLength: 'medium',
  includeInstallLink: false,
  installLinkUrl: '',
  includePartNumber: true,
  includeConditionDetail: true,
  customPromptNotes: '',
}

const DESCRIPTION_LENGTH_OPTIONS = [
  { value: 'short', label: 'Short', desc: '2–3 sentences, key facts only' },
  { value: 'medium', label: 'Medium', desc: '1–2 paragraphs, good detail' },
  { value: 'long', label: 'Long', desc: 'Full description with all details' },
]

// eBay OAuth config
const EBAY_CLIENT_ID = 'Discount-PartVaul-PRD-36c135696-64f7f7bf'
const EBAY_RUNAME = 'Discount_Tradin-Discount-PartVa-jhtznvhgx'
const EBAY_OAUTH_URL = `https://auth.ebay.com/oauth2/authorize?client_id=${EBAY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(EBAY_RUNAME)}&prompt=login&scope=${encodeURIComponent('https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.account.readonly')}`
const CLOUDFLARE_PROXY = 'https://partvault-proxy.leap00.workers.dev'
const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

function Section({ title, children }) {
  return (
    <div style={{ ...S.card, marginBottom: 16 }}>
      <h2 style={S.h2}>{title}</h2>
      {children}
    </div>
  )
}

function Toggle({ label, desc, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
          background: value ? C.accent : C.border, position: 'relative', transition: 'background .2s', flexShrink: 0, marginLeft: 16
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: value ? 22 : 3,
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
        }} />
      </button>
    </div>
  )
}

// ─── RECONCILE STAT CARD ────────────────────────────────────────────────────
function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: '#fafaf9', border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 18px', textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Inter Tight',system-ui,sans-serif", color: color || C.text }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function Settings({ profile, storeId, onSignOut }) {
  const [tab, setTab] = useState('account')
  const [footer, setFooter] = useState(DEFAULT_FOOTER)
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  // Anthropic API key (store-wide, used for AI parsing)
  const [anthropicKey, setAnthropicKey] = useState('')
  const [showAnthropicKey, setShowAnthropicKey] = useState(false)
  const [anthropicKeySaving, setAnthropicKeySaving] = useState(false)
  const [anthropicKeySaved, setAnthropicKeySaved] = useState(false)

  // eBay state
  const [ebayCreds, setEbayCreds] = useState({ appId: EBAY_CLIENT_ID, certId: '', ruName: EBAY_RUNAME })
  const [showCert, setShowCert] = useState(false)
  const [certIsSet, setCertIsSet] = useState(false)
  const [certUpdating, setCertUpdating] = useState(false)
  const [ebayConnected, setEbayConnected] = useState(false)
  const [ebayExpiry, setEbayExpiry] = useState(null)
  const [ebayUsername, setEbayUsername] = useState(null)
  const [ebayTesting, setEbayTesting] = useState(false)
  const [ebayTestResult, setEbayTestResult] = useState(null)
  const [credsSaving, setCredsSaving] = useState(false)
  const [credsSaved, setCredsSaved] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importJob, setImportJob] = useState(null)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState(null)
  const backfillCancelRef = useRef(false)
  const [importingHistory, setImportingHistory] = useState(false)
  const [historyResult, setHistoryResult] = useState(null)
  const historyCancelRef = useRef(false)
  const [backfillingCats, setBackfillingCats] = useState(false)
  const [backfillCatResult, setBackfillCatResult] = useState(null)
  const backfillCatCancelRef = useRef(false)
  const [parsing, setParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState(null) // { processed, total, failed }
  const parseCancelRef = useRef(false)
  const pollRef = useRef(null)

  // Reconcile state
  const [reconciling, setReconciling] = useState(false)
  const [reconcileResult, setReconcileResult] = useState(null)
  const [reconcileError, setReconcileError] = useState(null)
  const [retrying, setRetrying] = useState(false)
  const [retryResult, setRetryResult] = useState(null)
  const [clearingFlag, setClearingFlag] = useState(null) // partId being cleared

  // Stale resolution state
  const [enrichingStale, setEnrichingStale] = useState(false)
  const [enrichmentProgress, setEnrichmentProgress] = useState(null)
  const [enrichedData, setEnrichedData] = useState(null) // { [itemId]: { ebayStatus, endDate, salePrice, soldDate } }
  const [applyingResolutions, setApplyingResolutions] = useState(false)
  const [resolutionResult, setResolutionResult] = useState(null)
  const [rowSelections, setRowSelections] = useState({}) // { [partId]: actionKey } — overrides suggested action


  useEffect(() => {
    const init = async () => {
      await loadSettings()
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      if (code) {
        handleOAuthCallback(code)
        window.history.replaceState({}, '', window.location.pathname + '#settings-ebay')
        setTab('ebay')
      }
    }
    init()
  }, [storeId])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const loadSettings = async () => {
    if (!storeId) return
    try {
      const { data } = await sb.from('stores').select('settings').eq('id', storeId).single()
      if (data?.settings) {
        if (data.settings.footer) setFooter(data.settings.footer)
        if (data.settings.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
        if (data.settings.anthropicKey) setAnthropicKey(data.settings.anthropicKey)
      }
      // eBay credentials — non-sensitive fields from ebay_tokens; cert_id status via RPC (never exposed)
      const { data: tokenRow } = await sb.from('ebay_tokens').select('app_id, ru_name, expires_at').eq('store_id', storeId).maybeSingle()
      if (tokenRow) {
        setEbayCreds(c => ({ ...c, appId: tokenRow.app_id||c.appId, ruName: tokenRow.ru_name||c.ruName }))
        if (tokenRow.expires_at) {
          setEbayConnected(true)
          setEbayExpiry(tokenRow.expires_at)
          fetch(EDGE_FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_ebay_username', storeId }) })
            .then(r => r.json()).then(d => { if (d.username) setEbayUsername(d.username); else console.warn('get_ebay_username:', d) }).catch(e => console.warn('get_ebay_username fetch failed:', e))
        }
      }
      const { data: hasCert } = await sb.rpc('has_ebay_cert_id', { p_store_id: storeId })
      setCertIsSet(!!hasCert)
    } catch (e) {
      console.error('Failed to load settings', e)
    }
    setLoading(false)
  }

  const saveSettings = async () => {
    if (!storeId) return
    setSaving(true)
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const merged = { ...(current?.settings || {}), footer, aiDescription: aiSettings }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('Save failed', e)
    }
    setSaving(false)
  }

  const saveEbayCreds = async () => {
    if (!storeId) return
    setCredsSaving(true)
    try {
      // If a cert_id was entered, store it in Supabase Vault via SECURITY DEFINER RPC — it never persists in the browser
      if (ebayCreds.certId) {
        const { error: certErr } = await sb.rpc('set_ebay_cert_id', { p_store_id: storeId, p_cert_id: ebayCreds.certId })
        if (certErr) throw certErr
        setEbayCreds(c => ({ ...c, certId: '' }))
        setCertIsSet(true)
        setCertUpdating(false)
      }
      // App ID and RuName are non-sensitive — stored directly in ebay_tokens
      await sb.from('ebay_tokens').upsert(
        { store_id: storeId, app_id: ebayCreds.appId, ru_name: ebayCreds.ruName },
        { onConflict: 'store_id' }
      )
      setCredsSaved(true)
      setTimeout(() => setCredsSaved(false), 2000)
    } catch (e) {
      console.error('Save creds failed', e)
      alert(`Failed to save credentials: ${e.message}`)
    }
    setCredsSaving(false)
  }

  const saveAnthropicKey = async () => {
    if (!storeId) return
    setAnthropicKeySaving(true)
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const merged = { ...(current?.settings || {}), anthropicKey }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      setAnthropicKeySaved(true)
      setTimeout(() => setAnthropicKeySaved(false), 2000)
    } catch (e) {
      console.error('Save Anthropic key failed', e)
      alert(`Failed to save: ${e.message}`)
    }
    setAnthropicKeySaving(false)
  }

  const handleOAuthCallback = async (code) => {
    try {
      // Token exchange performed server-side — cert_id is read from Supabase Vault by the Edge Function
      // and never exposed to the browser. The browser only receives a success flag and expiry timestamp.
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'exchange_oauth_code', storeId, code }),
      })
      const result = await res.json()
      if (!res.ok || result.error) throw new Error(result.error || 'Token exchange failed')
      setEbayConnected(true)
      setEbayExpiry(result.expires_at)
      setEbayTestResult({ ok: true, msg: 'Connected to eBay successfully!' })
    } catch (e) {
      console.error('OAuth callback failed', e)
      setEbayTestResult({ ok: false, msg: `Connection failed: ${e.message}` })
    }
  }

  const connectEbay = () => {
    if (!certIsSet) {
      setEbayTestResult({ ok: false, msg: 'Please enter and save your Cert ID first.' })
      return
    }
    window.location.href = EBAY_OAUTH_URL
  }

  const disconnectEbay = async () => {
    try {
      await sb.from('ebay_tokens').update({ expires_at: new Date().toISOString() }).eq('store_id', storeId)
      setEbayConnected(false)
      setEbayExpiry(null)
      setEbayUsername(null)
      setEbayTestResult(null)
    } catch (e) {
      console.error('Disconnect failed', e)
    }
  }

  const testEbayConnection = async () => {
    setEbayTesting(true)
    setEbayTestResult(null)
    try {
      // Token is in Supabase Vault — check the metadata row for expiry status.
      // The Edge Function auto-refreshes expired tokens on first API call.
      const { data: tokenRow } = await sb.from('ebay_tokens').select('expires_at').eq('store_id', storeId).maybeSingle()
      if (!tokenRow) throw new Error('No eBay credentials found — connect first')
      const expiresAt = tokenRow.expires_at ? new Date(tokenRow.expires_at) : null
      if (expiresAt && expiresAt < new Date()) {
        setEbayTestResult({ ok: true, msg: 'Token expired but will auto-refresh on next import or reconcile' })
      } else if (expiresAt) {
        setEbayTestResult({ ok: true, msg: `Token valid until ${expiresAt.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' })}` })
      } else {
        setEbayTestResult({ ok: false, msg: 'No token expiry found — reconnect eBay' })
        setEbayConnected(false)
      }
    } catch (e) {
      setEbayTestResult({ ok: false, msg: `Failed: ${e.message}` })
    }
    setEbayTesting(false)
  }

  const importAllListings = async () => {
    setImporting(true)
    setImportJob({ status: 'starting', current_item: 'Fetching eBay listing IDs...' })
    try {
      // Step 1: start — fetches all IDs from eBay and creates job record
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', storeId }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      const jobId = data.jobId
      setImportJob({ status: 'running', current_item: 'Starting...', total_items: data.totalIds, imported: 0, skipped: 0, failed: 0, id: jobId })

      // Step 2: repeatedly call process_chunk until complete or cancelled
      const processNext = async () => {
        // Check for cancellation via Supabase
        const { data: jobCheck } = await sb.from('jobs').select('status').eq('id', jobId).single()
        if (jobCheck?.status === 'cancelled') {
          setImporting(false)
          setImportJob(j => ({ ...j, status: 'cancelled' }))
          return
        }

        try {
          const chunkRes = await fetch(EDGE_FN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'process_chunk', jobId, storeId }),
          })
          const chunk = await chunkRes.json()
          if (chunk.error && chunk.retry) {
            // Timeout — just retry the same chunk after a short pause
            console.log('Chunk timed out, retrying...')
            setTimeout(processNext, 2000)
            return
          }
          if (chunk.error) throw new Error(chunk.error)

          setImportJob(j => ({
            ...j,
            id: jobId,
            status: chunk.status,
            imported: chunk.imported,
            skipped: chunk.skipped,
            failed: chunk.failed,
            batch_offset: chunk.offset,
            total_items: chunk.total,
            current_item: chunk.isComplete
              ? `✓ Complete — ${chunk.imported} imported, ${chunk.skipped} skipped`
              : `Processing ${chunk.offset} of ${chunk.total}...`,
          }))

          if (chunk.isComplete || chunk.status === 'completed') {
            setImporting(false)
            return
          }

          // Small pause then next chunk
          setTimeout(processNext, 500)
        } catch (e) {
          setImportJob(j => ({ ...j, status: 'failed', error_message: e.message }))
          setImporting(false)
        }
      }

      setTimeout(processNext, 300)

    } catch (e) {
      setImportJob({ status: 'failed', error_message: e.message })
      setImporting(false)
    }
  }

  const runBackfill = async () => {
    backfillCancelRef.current = false
    setBackfilling(true)
    setBackfillResult(null)

    const WINDOW_DAYS = 30
    const YEARS_BACK  = 5
    const startDate   = new Date(Date.now() - YEARS_BACK * 365 * 24 * 60 * 60 * 1000)
    let windowEnd     = new Date()
    let totalUpdated  = 0
    let totalAlready  = 0
    let totalNotFound = 0
    const allErrors   = []

    try {
      while (windowEnd > startDate && !backfillCancelRef.current) {
        const windowStart = new Date(Math.max(
          windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
          startDate.getTime()
        ))

        setBackfillResult({
          progress: `Checking ${windowStart.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}…`,
          updated: totalUpdated,
          alreadySold: totalAlready,
        })

        const res = await fetch(EDGE_FN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action:   'backfill_orders',
            storeId,
            fromDate: windowStart.toISOString(),
            toDate:   windowEnd.toISOString(),
          }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)

        totalUpdated  += data.updated    || 0
        totalAlready  += data.alreadySold || 0
        totalNotFound += data.notFound   || 0
        if (data.errors?.length) allErrors.push(...data.errors)

        windowEnd = windowStart
      }

      setBackfillResult({ done: true, cancelled: backfillCancelRef.current, updated: totalUpdated, alreadySold: totalAlready, notFound: totalNotFound, errors: allErrors.slice(0, 20) })
    } catch (e) {
      setBackfillResult({ error: e.message, updated: totalUpdated })
    }
    setBackfilling(false)
  }

  const runSoldHistoryImport = async () => {
    historyCancelRef.current = false
    setImportingHistory(true)
    setHistoryResult(null)

    const WINDOW_DAYS = 30
    const startDate   = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    let windowEnd     = new Date()
    let totalCreated  = 0
    let totalSkipped  = 0
    let totalNoData   = 0
    const allErrors   = []

    try {
      while (windowEnd > startDate && !historyCancelRef.current) {
        const windowStart = new Date(Math.max(
          windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
          startDate.getTime()
        ))

        setHistoryResult({
          progress: `Checking ${windowStart.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}…`,
          created: totalCreated,
          skipped: totalSkipped,
        })

        let hasMore = true
        while (hasMore && !historyCancelRef.current) {
          const res = await fetch(EDGE_FN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action:   'import_sold_history',
              storeId,
              fromDate: windowStart.toISOString(),
              toDate:   windowEnd.toISOString(),
            }),
          })
          const data = await res.json()
          if (data.error) throw new Error(data.error)

          totalCreated  += data.created || 0
          totalSkipped  += data.skipped || 0
          totalNoData   += data.noData  || 0
          if (data.errors?.length) allErrors.push(...data.errors)
          hasMore = data.hasMore || false

          setHistoryResult({
            progress: `Checking ${windowStart.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}${hasMore ? ' (continuing…)' : ''}`,
            created: totalCreated,
            skipped: totalSkipped,
          })
        }

        windowEnd = windowStart
      }

      setHistoryResult({ done: true, cancelled: historyCancelRef.current, created: totalCreated, skipped: totalSkipped, noData: totalNoData, errors: allErrors.slice(0, 20) })
    } catch (e) {
      setHistoryResult({ error: e.message, created: totalCreated })
    }
    setImportingHistory(false)
  }

  const runCategoryBackfill = async () => {
    backfillCatCancelRef.current = false
    setBackfillingCats(true)
    setBackfillCatResult(null)
    let totalUpdated = 0
    let totalNoData  = 0
    try {
      let hasMore = true
      while (hasMore && !backfillCatCancelRef.current) {
        setBackfillCatResult({ progress: true, updated: totalUpdated, noData: totalNoData })
        const res = await fetch(EDGE_FN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'backfill_categories', storeId }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        totalUpdated += data.updated || 0
        totalNoData  += data.noData  || 0
        hasMore = data.hasMore || false
      }
      setBackfillCatResult({ done: true, cancelled: backfillCatCancelRef.current, updated: totalUpdated, noData: totalNoData })
    } catch (e) {
      setBackfillCatResult({ error: e.message, updated: totalUpdated })
    }
    setBackfillingCats(false)
  }

  const cancelImport = async () => {
    if (!importJob?.id) return
    // Mark cancelled in Supabase — processNext loop checks this before each chunk
    await sb.from('jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', importJob.id)
    setImporting(false)
    setImportJob(j => ({ ...j, status: 'cancelled' }))
  }

  // ─── RECONCILE ───────────────────────────────────────────────────────────
  const runReconcile = async () => {
    setReconciling(true)
    setReconcileResult(null)
    setReconcileError(null)
    setRetryResult(null)
    setEnrichedData(null)
    setResolutionResult(null)
    setRowSelections({})
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile', storeId }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setReconcileResult(data)
      if (data.staleListings?.length > 0) {
        await enrichStaleParts(data.staleListings)
      }
    } catch (e) {
      setReconcileError(e.message)
    }
    setReconciling(false)
  }

  const retryFailed = async () => {
    if (!reconcileResult?.failedItems?.length) return
    setRetrying(true)
    setRetryResult(null)
    try {
      const ids = reconcileResult.failedItems.map(f => f.itemId)
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry', storeId, retryIds: ids }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setRetryResult(data)
      // Re-run reconcile to refresh counts
      await runReconcile()
    } catch (e) {
      setRetryResult({ error: e.message })
    }
    setRetrying(false)
  }

  const enrichStaleParts = async (staleListings) => {
    const listings = staleListings || reconcileResult?.staleListings
    if (!listings?.length) return
    setEnrichingStale(true)
    setEnrichedData(null)
    setEnrichmentProgress({ current: 0, total: listings.length })
    try {
      const itemIds = listings.map(l => l.platformListingId).filter(Boolean)
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enrich_stale', storeId, itemIds }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      const indexed = {}
      data.enriched.forEach(e => { indexed[e.itemId] = e })
      setEnrichedData(indexed)
    } catch (e) {
      alert(`eBay status check failed: ${e.message}`)
    }
    setEnrichingStale(false)
    setEnrichmentProgress(null)
  }

  // Action options available per row. The "suggested" one is pre-selected based on eBay status.
  const ACTION_OPTIONS = {
    sold:        { label: 'Mark Sold',        resolution: 'sold',        color: C.green },
    ended:       { label: 'Mark Ended',       resolution: 'ended',       color: C.yellow },
    defer:       { label: 'Defer for Review', resolution: 'defer',       color: C.accent },
    keep_active: { label: 'Keep Active',      resolution: 'keep_active', color: C.muted },
  }

  const suggestedActionKey = (enriched) => {
    if (!enriched) return 'keep_active'
    if (enriched.ebayStatus === 'Sold') return 'sold'
    if (enriched.ebayStatus === 'Ended') return 'defer'
    if (enriched.ebayStatus === 'NotFound') return 'ended'
    if (enriched.ebayStatus === 'Active') return 'keep_active'
    return 'keep_active'
  }

  const getRowAction = (listingId, enriched) => {
    const key = rowSelections[listingId] || suggestedActionKey(enriched)
    return { key, ...ACTION_OPTIONS[key] }
  }

  const applyResolution = async (listingId, partId, platformListingId) => {
    const enriched = enrichedData?.[platformListingId]
    const action = getRowAction(listingId, enriched)
    setClearingFlag(listingId)
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'apply_stale_resolution',
          storeId,
          resolutions: [{
            listingId,
            partId,
            resolution: action.resolution,
            salePrice: action.key === 'sold' ? enriched?.salePrice : undefined,
            soldDate: action.key === 'sold' ? enriched?.soldDate : undefined,
          }],
        }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setReconcileResult(r => ({
        ...r,
        staleListings: r.staleListings.filter(l => l.id !== listingId),
        staleCount: r.staleCount - 1,
      }))
    } catch (e) {
      alert(`Resolution failed: ${e.message}`)
    }
    setClearingFlag(null)
  }

  const applyAllResolutions = async () => {
    if (!enrichedData || !reconcileResult?.staleListings?.length) return
    if (!confirm(`Apply suggested actions to all ${reconcileResult.staleListings.length} stale listings? This will update statuses in PartVault.`)) return
    setApplyingResolutions(true)
    setResolutionResult(null)
    try {
      const resolutions = reconcileResult.staleListings.map(l => {
        const enriched = enrichedData[l.platformListingId]
        const action = getRowAction(l.id, enriched)
        return {
          listingId: l.id,
          partId: l.partId,
          resolution: action.resolution,
          salePrice: action.key === 'sold' ? enriched?.salePrice : undefined,
          soldDate: action.key === 'sold' ? enriched?.soldDate : undefined,
        }
      })
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply_stale_resolution', storeId, resolutions }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setResolutionResult({ ok: true, msg: `✓ Updated ${data.updated} listings` })
      setReconcileResult(r => ({ ...r, staleListings: [], staleCount: 0 }))
      setEnrichedData(null)
      setRowSelections({})
    } catch (e) {
      setResolutionResult({ ok: false, msg: `Failed: ${e.message}` })
    }
    setApplyingResolutions(false)
  }

  const clearStaleFlag = async (listingId) => {
    setClearingFlag(listingId)
    try {
      await sb.from('listings').update({ reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', listingId)
      setReconcileResult(r => ({
        ...r,
        staleListings: r.staleListings.filter(l => l.id !== listingId),
        staleCount: r.staleCount - 1,
      }))
    } catch (e) {
      console.error('Clear flag failed', e)
    }
    setClearingFlag(null)
  }

  // ===== Persistent parse loop (lives on window, survives component unmount) =====
  // Settings.jsx mounts → reattaches to in-flight parse if any.
  // Settings.jsx unmounts → loop keeps running because it's not tied to React.

  // On mount, sync local state from window.__partvaultParse if a parse is in progress
  useEffect(() => {
    const w = typeof window !== 'undefined' ? window : null
    if (!w) return
    if (w.__partvaultParse?.running) {
      setParsing(true)
      setParseProgress(w.__partvaultParse.progress || null)
    }
    const onUpdate = () => {
      const p = w.__partvaultParse
      if (p?.running) {
        setParsing(true)
        setParseProgress(p.progress)
      } else {
        setParsing(false)
        setParseProgress(null)
      }
    }
    w.addEventListener('partvault-parse-update', onUpdate)
    return () => w.removeEventListener('partvault-parse-update', onUpdate)
  }, [])

  const parseMakeModelYear = async () => {
    if (!anthropicKey) {
      alert('No Anthropic API key saved. Add it in the Account tab and click Save.')
      return
    }
    if (window.__partvaultParse?.running) {
      alert('A parse is already running.')
      return
    }

    // Initialise the singleton on window
    const job = window.__partvaultParse = {
      running: true,
      cancelled: false,
      progress: { processed: 0, total: 0, failed: 0, current: 'Loading parts…' },
    }
    const broadcast = () => window.dispatchEvent(new CustomEvent('partvault-parse-update'))
    broadcast()

    try {
      const { data: parts, error } = await sb
        .from('parts')
        .select('id,title')
        .eq('store_id', storeId)
        .or('make.is.null,make.eq.')
        .range(0, 9999)
      if (error) throw error
      if (!parts?.length) {
        alert('No unprocessed parts found.')
        job.running = false
        broadcast()
        delete window.__partvaultParse
        return
      }
      const total = parts.length
      job.progress = { processed: 0, total, failed: 0, current: '' }
      broadcast()

      let processed = 0
      let failed = 0
      for (const part of parts) {
        if (job.cancelled) break
        job.progress = { processed, total, failed, current: part.title?.slice(0, 60) || '' }
        broadcast()
        try {
          const res = await fetch(CLOUDFLARE_PROXY, {
            method: 'POST',
            headers: { 'x-api-key': anthropicKey, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001', max_tokens: 200,
              messages: [{ role: 'user', content: `Extract make, model, and year range from this eBay car parts listing title. Return JSON only: {"make":"","model":"","year":""}\n\nThe "year" field should be a string like "2011-2017" for a range, or "2014" for a single year, or empty if unknown.\n\nTitle: ${part.title}` }]
            })
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const d = await res.json()
          const text = d.content?.[0]?.text || '{}'
          const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
          await sb.from('parts').update({
            make: parsed.make || null,
            model: parsed.model || null,
            year: parsed.year || null,
          }).eq('id', part.id)
        } catch (err) {
          console.error('Parse failed for part', part.id, err)
          failed += 1
        }
        processed += 1
        job.progress = { processed, total, failed, current: part.title?.slice(0, 60) || '' }
        broadcast()
        await new Promise(r => setTimeout(r, 400))
      }

      const wasCancelled = job.cancelled
      const summary = `${wasCancelled ? 'Cancelled' : 'Done'}. Processed ${processed} of ${total} parts. ${failed} failed.`
      job.running = false
      job.summary = summary
      broadcast()
      alert(summary)
    } catch (e) {
      job.running = false
      broadcast()
      alert(`Parse failed: ${e.message}`)
    } finally {
      // Clear after a short delay so the UI can react to running=false
      setTimeout(() => { delete window.__partvaultParse; broadcast() }, 500)
    }
  }

  const cancelParse = () => {
    if (window.__partvaultParse) window.__partvaultParse.cancelled = true
  }

  const setAi = (k, v) => setAiSettings(s => ({ ...s, [k]: v }))

  const previewDescription = () => {
    const yearRange = aiSettings.includeYearRange ? 'Suits [XXXX]–[XXXX] models (AI-determined)' : ''
    const partDesc = {
      short: 'Genuine OEM [Part Name] in [Condition] condition.',
      medium: 'Genuine OEM [Part Name] removed from a [Year] [Make] [Model]. Part is in [Condition] condition with [minor/no] visible wear. All photos are of the actual item.',
      long: 'Genuine OEM [Part Name] removed from a [Year] [Make] [Model] [Series]. This part is in [Condition] condition. [Detail about wear/function]. Part number: [OEM#]. All photos are of the exact item you will receive — no stock images used.',
    }[aiSettings.descriptionLength]
    let preview = `${partDesc}\n\n`
    if (yearRange) preview += `${yearRange}\n\n`
    if (aiSettings.includePartNumber) preview += `OEM Part Number: [Part Number]\n\n`
    if (aiSettings.includeInstallLink && aiSettings.installLinkUrl) preview += `Installation guide: ${aiSettings.installLinkUrl}\nDisclaimer: We recommend all parts are installed by a qualified mechanic.\n\n`
    preview += '---\n\n' + footer
    return preview
  }

  const SETTING_TABS = [
    { id: 'account', label: '👤 Account' },
    { id: 'descriptions', label: '📝 Descriptions' },
    { id: 'ebay', label: '🛒 eBay Sync' },
  ]

  const importProgress = importJob ? (() => {
    const total = importJob.total_items || 0
    const done = (importJob.imported || 0) + (importJob.skipped || 0)
    return total > 0 ? Math.round((done / total) * 100) : 0
  })() : 0

  // ─── RECONCILE SECTION COMPONENT ─────────────────────────────────────────
  const ReconcileSection = () => (
    <>
      <Section title="🔄 Reconcile with eBay">

        {reconcileError && (
          <div style={{ padding: 12, borderRadius: 8, marginBottom: 12, background: '#fef2f2', border: `1px solid #fca5a5`, fontSize: 13, color: C.red }}>
            ✗ {reconcileError}
          </div>
        )}

        {reconcileResult && (
          <>
            {/* Count comparison */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <StatCard label="eBay Active" value={reconcileResult.ebayActiveCount} color={C.blue} />
              <StatCard label="PartVault Active" value={reconcileResult.pvActiveCount} color={C.accent} />
              <StatCard label="Missing" value={reconcileResult.missingCount} color={reconcileResult.missingCount > 0 ? C.yellow : C.green} sub="in eBay, not imported" />
              <StatCard label="Stale" value={reconcileResult.staleCount} color={reconcileResult.staleCount > 0 ? C.red : C.green} sub="flagged for review" />
            </div>

            <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>
              Last reconciled: {new Date(reconcileResult.reconciledAt).toLocaleString('en-AU')}
            </div>

            {/* Stale parts */}
            {reconcileResult.staleCount > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.text, marginBottom: 8 }}>
                  ⚠️ Stale Parts — Listed in PartVault but not active on eBay
                </div>

                {/* Checking status spinner — shown while auto-enrichment runs */}
                {enrichingStale && (
                  <div style={{ padding: 12, borderRadius: 8, marginBottom: 12, background: '#fffbeb', border: `1px solid #fde68a`, fontSize: 13, color: '#78350f' }}>
                    ⏳ Checking eBay status for {enrichmentProgress?.total || reconcileResult.staleCount} stale listings…
                  </div>
                )}

                {/* Bulk action banner — shows after enrichment */}
                {enrichedData && (
                  <div style={{ padding: 14, borderRadius: 8, marginBottom: 12, background: '#f0fdf4', border: `1px solid #86efac` }}>
                    <div style={{ fontSize: 13, color: C.green, lineHeight: 1.6, marginBottom: 10 }}>
                      ✓ Status retrieved from eBay. Each row has a dropdown with the suggested action pre-selected — change any you want, then click <strong>"Apply All Suggested Actions"</strong> to run them all at once. Or click <strong>Apply</strong> on individual rows.
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7, marginBottom: 12 }}>
                      <strong>Mark Sold</strong> — records sale price and date.
                      &nbsp;<strong>Mark Archived</strong> — part is gone, removes from active inventory.
                      &nbsp;<strong>Defer for Review</strong> — keeps part in PartVault and excludes it from future reconciles, awaiting a relist / discount / scrap decision.
                      &nbsp;<strong>Clear Flag</strong> — keeps part as Listed without deferring (it'll re-flag on next reconcile if still missing from eBay).
                    </div>
                    <button
                      onClick={applyAllResolutions}
                      disabled={applyingResolutions}
                      style={{ ...S.btn('primary'), fontSize: 13, padding: '8px 16px', opacity: applyingResolutions ? 0.6 : 1 }}
                    >
                      {applyingResolutions ? '⏳ Applying...' : '✓ Apply All Suggested Actions'}
                    </button>
                    {resolutionResult && (
                      <div style={{ marginTop: 8, fontSize: 12, color: resolutionResult.ok ? C.green : C.red }}>
                        {resolutionResult.msg}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f4f0' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>eBay Item ID</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>SKU</th>
                        {enrichedData && (
                          <>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>eBay Status</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>End Date</th>
                          </>
                        )}
                        <th style={{ padding: '8px 12px', textAlign: 'center', color: C.muted, fontWeight: 600 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(reconcileResult.staleListings || []).map((l, i) => {
                        const enriched = enrichedData?.[l.platformListingId]
                        const action = enriched ? getRowAction(l.id, enriched) : null
                        const suggestedKey = enriched ? suggestedActionKey(enriched) : null
                        return (
                          <tr key={l.id} style={{ borderTop: i > 0 ? `1px solid ${C.border}` : 'none', background: '#fff' }}>
                            <td style={{ padding: '8px 12px', color: C.muted, fontFamily: 'monospace', fontSize: 12 }}>{l.platformListingId}</td>
                            <td style={{ padding: '8px 12px', color: C.text, fontFamily: 'monospace', fontSize: 12 }}>{l.platformSku || '—'}</td>
                            {enrichedData && (
                              <>
                                <td style={{ padding: '8px 12px', fontSize: 12 }}>
                                  {enriched ? (
                                    <span style={{
                                      fontWeight: 600,
                                      color: enriched.ebayStatus === 'Sold' ? C.green
                                        : enriched.ebayStatus === 'Active' ? C.blue
                                        : enriched.ebayStatus === 'NotFound' ? C.red
                                        : enriched.ebayStatus === 'Error' ? C.red
                                        : C.yellow
                                    }}>
                                      {enriched.ebayStatus}
                                      {enriched.salePrice ? ` ($${enriched.salePrice})` : ''}
                                    </span>
                                  ) : (
                                    <span style={{ color: C.muted }}>—</span>
                                  )}
                                </td>
                                <td style={{ padding: '8px 12px', fontSize: 12, color: C.muted }}>
                                  {enriched?.endDate
                                    ? new Date(enriched.endDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' })
                                    : '—'}
                                </td>
                              </>
                            )}
                            <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                              {enrichedData ? (
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', flexWrap: 'nowrap' }}>
                                  <select
                                    value={rowSelections[l.id] || suggestedKey}
                                    onChange={e => setRowSelections(s => ({ ...s, [l.id]: e.target.value }))}
                                    disabled={clearingFlag === l.id}
                                    style={{
                                      fontSize: 11,
                                      padding: '4px 6px',
                                      borderRadius: 6,
                                      border: `1px solid ${C.border}`,
                                      background: '#fff',
                                      color: C.text,
                                      cursor: 'pointer',
                                      minWidth: 130,
                                    }}
                                  >
                                    {Object.entries(ACTION_OPTIONS).map(([key, opt]) => (
                                      <option key={key} value={key}>
                                        {opt.label}{key === suggestedKey ? ' (suggested)' : ''}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    onClick={() => applyResolution(l.id, l.partId, l.platformListingId)}
                                    disabled={clearingFlag === l.id}
                                    style={{
                                      ...S.btn('primary'),
                                      fontSize: 11,
                                      padding: '4px 10px',
                                      opacity: clearingFlag === l.id ? 0.5 : 1,
                                    }}
                                  >
                                    {clearingFlag === l.id ? '...' : 'Apply'}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => clearStaleFlag(l.id)}
                                  disabled={clearingFlag === l.id}
                                  style={{ ...S.btn('secondary'), fontSize: 11, padding: '4px 10px', opacity: clearingFlag === l.id ? 0.5 : 1 }}
                                >
                                  {clearingFlag === l.id ? '...' : 'Clear Flag'}
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Missing IDs */}
            {reconcileResult.missingCount > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.text, marginBottom: 8 }}>
                  📥 Missing from PartVault ({reconcileResult.missingCount} items{reconcileResult.missingCount > 50 ? ', showing first 50' : ''})
                </div>
                <div style={{ background: '#fffbeb', border: `1px solid #fde68a`, borderRadius: 8, padding: 12, fontSize: 12, color: '#78350f', lineHeight: 1.8, fontFamily: 'monospace', maxHeight: 120, overflowY: 'auto' }}>
                  {reconcileResult.missingIds.join(', ')}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
                  These eBay item IDs are active on eBay but not yet in PartVault. Run Import to pull them in.
                </div>
              </div>
            )}

            {/* Failed items */}
            {reconcileResult.failedCount > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>
                    ✗ Failed Items ({reconcileResult.failedCount})
                  </div>
                  <button
                    onClick={retryFailed}
                    disabled={retrying}
                    style={{ ...S.btn('primary'), fontSize: 12, padding: '6px 14px', opacity: retrying ? 0.6 : 1 }}
                  >
                    {retrying ? '⏳ Retrying...' : '↺ Retry All Failed'}
                  </button>
                </div>

                {retryResult && !retryResult.error && (
                  <div style={{ padding: 10, borderRadius: 8, marginBottom: 10, background: '#f0fdf4', border: `1px solid #86efac`, fontSize: 13, color: C.green }}>
                    ✓ Retry complete — {retryResult.imported} imported, {retryResult.failed} still failing
                  </div>
                )}
                {retryResult?.error && (
                  <div style={{ padding: 10, borderRadius: 8, marginBottom: 10, background: '#fef2f2', border: `1px solid #fca5a5`, fontSize: 13, color: C.red }}>
                    ✗ {retryResult.error}
                  </div>
                )}

                <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f4f0' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>Item ID</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconcileResult.failedItems.map((f, i) => (
                        <tr key={f.itemId} style={{ borderTop: i > 0 ? `1px solid ${C.border}` : 'none', background: '#fff' }}>
                          <td style={{ padding: '8px 12px', color: C.muted, fontFamily: 'monospace', fontSize: 12 }}>{f.itemId}</td>
                          <td style={{ padding: '8px 12px', color: C.red, fontSize: 12 }}>{f.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* All clear */}
            {reconcileResult.staleCount === 0 && reconcileResult.missingCount === 0 && reconcileResult.failedCount === 0 && (
              <div style={{ padding: 14, borderRadius: 8, background: '#f0fdf4', border: `1px solid #86efac`, fontSize: 14, color: C.green, fontWeight: 600, textAlign: 'center' }}>
                ✓ All clear — PartVault matches eBay
              </div>
            )}
          </>
        )}

        <button
          style={{ ...S.btn('primary'), width: '100%', marginTop: reconcileResult ? 12 : 0, opacity: (reconciling || enrichingStale || !ebayConnected) ? 0.6 : 1 }}
          onClick={runReconcile}
          disabled={reconciling || enrichingStale || !ebayConnected}
        >
          {reconciling ? '⏳ Reconciling...' : enrichingStale ? '⏳ Checking eBay status...' : reconcileResult ? '↺ Run Again' : '🔄 Run Reconcile'}
        </button>
        {!ebayConnected && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Connect eBay above to enable reconcile.</div>
        )}
      </Section>
    </>
  )

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${C.border}` }}>
        <h2 style={S.h1}>⚙️ Settings</h2>
        {tab === 'descriptions' && (
          <button style={{ ...S.btn(), opacity: saving ? 0.6 : 1 }} onClick={saveSettings} disabled={saving}>
            {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save Settings'}
          </button>
        )}
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: `2px solid ${C.border}`, paddingBottom: 0 }}>
        {SETTING_TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 18px', fontSize: 13, fontWeight: tab === t.id ? 700 : 500,
            color: tab === t.id ? C.accent : C.muted,
            borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: -2, transition: 'all .15s'
          }}>{t.label}</button>
        ))}
      </div>

      {/* ACCOUNT TAB */}
      {tab === 'account' && (
        <>
          <Section title="Account">
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.9, marginBottom: 16 }}>
              <div>Logged in as: <strong style={{ color: C.text }}>{profile?.name || profile?.email || '—'}</strong></div>
              <div>Role: <strong style={{ color: C.text }}>{profile?.role || '—'}</strong></div>
              <div>Store: <strong style={{ color: C.text }}>{profile?.store?.name || '—'}</strong></div>
            </div>
            <button style={{ ...S.btn('danger'), padding: '10px 24px' }} onClick={onSignOut}>Sign Out</button>
          </Section>
          <Section title="Anthropic API Key">
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
              Used for AI-powered parsing of make / model / year from listing titles. Stored against your store, so workers don't need to set it on each device. Get a key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener" style={{ color: C.accent }}>console.anthropic.com</a>.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: '1 1 320px', minWidth: 0 }}>
                <input
                  type={showAnthropicKey ? 'text' : 'password'}
                  value={anthropicKey}
                  onChange={e => setAnthropicKey(e.target.value)}
                  placeholder="sk-ant-api03-..."
                  style={{ ...S.input, width: '100%', paddingRight: 70, fontFamily: 'monospace', fontSize: 13 }}
                />
                <button
                  type="button"
                  onClick={() => setShowAnthropicKey(s => !s)}
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 'none', color: C.muted, cursor: 'pointer',
                    fontSize: 12, padding: '4px 8px',
                  }}
                >{showAnthropicKey ? 'Hide' : 'Show'}</button>
              </div>
              <button
                onClick={saveAnthropicKey}
                disabled={anthropicKeySaving || !anthropicKey}
                style={{ ...S.btn(anthropicKeySaved ? 'success' : 'primary'), padding: '0 20px', whiteSpace: 'nowrap' }}
              >
                {anthropicKeySaving ? 'Saving…' : anthropicKeySaved ? '✓ Saved' : 'Save'}
              </button>
            </div>
          </Section>
          <Section title="Supabase Connection">
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.9 }}>
              <div style={{ color: C.green }}>● Real-time sync active</div>
              <div>Changes from the mobile app appear instantly.</div>
            </div>
          </Section>
          <div style={S.card}>
            <div style={{ fontSize: 12, color: C.muted }}>PartVault Admin v{APP_VERSION}</div>
          </div>
        </>
      )}

      {/* DESCRIPTIONS TAB */}
      {tab === 'descriptions' && !loading && (
        <>
          <Section title="🤖 AI Description Template">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Configure what information the AI includes when generating part descriptions.
            </p>
            <div style={{ marginBottom: 20 }}>
              <label style={S.label}>Description Length</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {DESCRIPTION_LENGTH_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setAi('descriptionLength', opt.value)} style={{
                    flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                    border: `2px solid ${aiSettings.descriptionLength === opt.value ? C.accent : C.border}`,
                    background: aiSettings.descriptionLength === opt.value ? C.accent + '15' : '#fff',
                    color: aiSettings.descriptionLength === opt.value ? C.accent : C.text,
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
            <Toggle label="Include Make" value={aiSettings.includeMake} onChange={v => setAi('includeMake', v)} />
            <Toggle label="Include Model" value={aiSettings.includeModel} onChange={v => setAi('includeModel', v)} />
            <Toggle label="Include Series/Badge" desc="e.g. GLX, Sport, Executive" value={aiSettings.includeSeries} onChange={v => setAi('includeSeries', v)} />
            <Toggle label="Include Year Range Compatibility" desc="AI determines which years this part suits — critical for sales." value={aiSettings.includeYearRange} onChange={v => setAi('includeYearRange', v)} />
            <Toggle label="Include OEM Part Number" value={aiSettings.includePartNumber} onChange={v => setAi('includePartNumber', v)} />
            <Toggle label="Include Condition Detail" desc="Describes visible wear based on condition field" value={aiSettings.includeConditionDetail} onChange={v => setAi('includeConditionDetail', v)} />
            <Toggle label="Include Installation Guide Link" desc="Adds a link with disclaimer recommending professional installation" value={aiSettings.includeInstallLink} onChange={v => setAi('includeInstallLink', v)} />
            {aiSettings.includeInstallLink && (
              <div style={{ marginTop: 12 }}>
                <label style={S.label}>Installation Guide URL</label>
                <input style={S.input} placeholder="https://..." value={aiSettings.installLinkUrl} onChange={e => setAi('installLinkUrl', e.target.value)} />
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <label style={S.label}>Additional Notes for AI (optional)</label>
              <textarea style={{ ...S.textarea, minHeight: 70 }} placeholder="e.g. Always mention free returns. Avoid using the word 'used' — say 'pre-owned' instead." value={aiSettings.customPromptNotes} onChange={e => setAi('customPromptNotes', e.target.value)} />
            </div>
          </Section>

          <Section title="📄 Standard Footer">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
              This text is appended to every listing description below the AI-generated content.
            </p>
            <textarea style={{ ...S.textarea, minHeight: 240, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7 }} value={footer} onChange={e => setFooter(e.target.value)} />
          </Section>

          <Section title="👁 Description Preview">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
              Placeholders in [brackets] will be filled by AI.
            </p>
            <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: C.text, fontFamily: 'inherit', maxHeight: 400, overflowY: 'auto' }}>
              {previewDescription()}
            </div>
          </Section>
        </>
      )}

      {/* EBAY SYNC TAB */}
      {tab === 'ebay' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          <div>
          {/* Credentials */}
          <Section title="🔑 eBay API Credentials">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Read-only access — stored in Supabase
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>App ID (Client ID)</label>
                <input style={S.input} value={ebayCreds.appId} onChange={e => setEbayCreds(c => ({ ...c, appId: e.target.value }))} placeholder="App ID" />
              </div>
              <div>
                <label style={S.label}>RuName</label>
                <input style={S.input} value={ebayCreds.ruName} onChange={e => setEbayCreds(c => ({ ...c, ruName: e.target.value }))} placeholder="RuName" />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Cert ID (Client Secret)</label>
              {certIsSet && !certUpdating ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#f0fdf4', border: `1.5px solid #86efac`, borderRadius: 8 }}>
                  <span style={{ fontSize: 13, color: C.green, fontWeight: 600, flex: 1 }}>●●●●●●●●●●●● Stored securely in Vault</span>
                  <button onClick={() => setCertUpdating(true)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: C.muted }}>
                    Update
                  </button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...S.input, paddingRight: 60 }}
                    type={showCert ? 'text' : 'password'}
                    value={ebayCreds.certId}
                    onChange={e => setEbayCreds(c => ({ ...c, certId: e.target.value }))}
                    placeholder={certUpdating ? 'Enter new Cert ID to replace stored value' : 'Cert ID'}
                    autoFocus={certUpdating}
                  />
                  <button onClick={() => setShowCert(s => !s)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: C.muted, fontSize: 12 }}>
                    {showCert ? 'Hide' : 'Show'}
                  </button>
                </div>
              )}
              <p style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
                Write-only — once saved, this value is encrypted in Supabase Vault and never returned to the browser.
              </p>
            </div>
            <button style={{ ...S.btn('primary'), opacity: credsSaving ? 0.6 : 1 }} onClick={saveEbayCreds} disabled={credsSaving}>
              {credsSaving ? 'Saving...' : credsSaved ? '✓ Saved' : 'Save Credentials'}
            </button>
          </Section>

          {/* Connection */}
          <Section title="🔗 eBay Connection">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: 16, background: ebayConnected ? '#f0fdf4' : '#fafaf9', border: `1px solid ${ebayConnected ? '#86efac' : C.border}`, borderRadius: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: ebayConnected ? C.green : C.muted, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: ebayConnected ? C.green : C.muted }}>
                  {ebayConnected ? `Connected to eBay${ebayUsername ? ` — ${ebayUsername}` : ''}` : 'Not connected'}
                </div>
                {ebayConnected && ebayExpiry && (
                  <div style={{ fontSize: 12, color: C.muted }}>
                    Expires: {new Date(ebayExpiry).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                )}
              </div>
            </div>

            {ebayTestResult && (
              <div style={{ padding: 12, borderRadius: 8, marginBottom: 12, background: ebayTestResult.ok ? '#f0fdf4' : '#fef2f2', border: `1px solid ${ebayTestResult.ok ? '#86efac' : '#fca5a5'}`, fontSize: 13, color: ebayTestResult.ok ? C.green : C.red }}>
                {ebayTestResult.ok ? '✓ ' : '✗ '}{ebayTestResult.msg}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ ...S.btn('blue'), flex: 1, opacity: ebayTesting ? 0.6 : 1 }} onClick={testEbayConnection} disabled={ebayTesting || !ebayConnected}>
                {ebayTesting ? 'Testing...' : 'Test'}
              </button>
              {ebayConnected ? (
                <button style={{ ...S.btn('danger'), flex: 1 }} onClick={disconnectEbay}>Disconnect</button>
              ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button style={{ ...S.btn('primary'), width: '100%' }} onClick={connectEbay}>Connect eBay</button>
                  <div style={{ fontSize: 11, color: C.muted, textAlign: 'center' }}>
                    Wrong account?{' '}
                    <a href="https://www.ebay.com.au/signin/out" target="_blank" rel="noreferrer" style={{ color: C.accent }}>Sign out of eBay</a>
                    {' '}first, then log in as the correct account before connecting.
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* Parse with AI */}
          <Section title="🤖 Parse with AI">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Extracts make, model and year from listing titles using Claude Haiku. Processes all unparsed listings in one run. Requires your Anthropic API key saved in the Account tab.
            </p>

            {parsing && parseProgress && (
              <div style={{ marginBottom: 12, padding: 12, background: '#f8fafb', borderRadius: 8, border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                    {parseProgress.total === 0 ? 'Loading…' : `Processing ${parseProgress.processed} of ${parseProgress.total}`}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted }}>
                    {parseProgress.total > 0 && `${Math.round((parseProgress.processed / parseProgress.total) * 100)}%`}
                    {parseProgress.failed > 0 && <span style={{ color: C.red, marginLeft: 8 }}>{parseProgress.failed} failed</span>}
                  </div>
                </div>
                <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: parseProgress.total > 0 ? `${(parseProgress.processed / parseProgress.total) * 100}%` : '0%',
                    background: C.accent,
                    transition: 'width .3s ease',
                  }} />
                </div>
                {parseProgress.current && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 8, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {parseProgress.current}
                  </div>
                )}
              </div>
            )}

            {parsing ? (
              <button style={{ ...S.btn('danger'), width: '100%' }} onClick={cancelParse}>
                ✕ Cancel
              </button>
            ) : (
              <button style={{ ...S.btn('primary'), width: '100%' }} onClick={parseMakeModelYear}>
                🔍 Parse Make / Model / Year
              </button>
            )}
          </Section>

          </div>{/* end left column */}

          {/* RIGHT COLUMN */}
          <div>
            {/* Import */}
            <Section title="📥 eBay Sync">
              {importJob && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: C.text }}>{importJob.current_item || 'Processing...'}</span>
                    <span style={{ color: C.muted }}>{importProgress}%</span>
                  </div>
                  <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${importProgress}%`, background: importJob.status === 'completed' ? C.green : C.accent, transition: 'width 0.5s' }} />
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button style={{ ...S.btn('primary'), flex: 1, opacity: (importing || !ebayConnected) ? 0.6 : 1 }} onClick={importAllListings} disabled={importing || !ebayConnected}>
                  {importing ? '⏳ Importing...' : '📥 Import All eBay Listings'}
                </button>
                {importing && <button style={S.btn('danger')} onClick={cancelImport}>Cancel</button>}
              </div>

              {/* Maintenance tools — compact rows */}
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                {[
                  {
                    label: 'Backfill Historical Sales',
                    running: backfilling,
                    onRun: runBackfill,
                    onCancel: () => { backfillCancelRef.current = true },
                    result: backfillResult,
                    resultText: r => r.done
                      ? `${r.updated} marked sold · ${r.alreadySold} already · ${r.notFound} not found${r.cancelled ? ' (cancelled)' : ''}`
                      : r.progress || 'Running…',
                  },
                  {
                    label: 'Import Sales History',
                    running: importingHistory,
                    onRun: runSoldHistoryImport,
                    onCancel: () => { historyCancelRef.current = true },
                    result: historyResult,
                    resultText: r => r.done
                      ? `${r.created} created · ${r.skipped} already in PartVault${r.cancelled ? ' (cancelled)' : ''}`
                      : r.progress || 'Running…',
                  },
                  {
                    label: 'Backfill Categories',
                    running: backfillingCats,
                    onRun: runCategoryBackfill,
                    onCancel: () => { backfillCatCancelRef.current = true },
                    result: backfillCatResult,
                    resultText: r => r.done
                      ? `${r.updated} updated · ${r.noData} no data${r.cancelled ? ' (cancelled)' : ''}`
                      : 'Running…',
                  },
                ].map(({ label, running, onRun, onCancel, result, resultText }, idx, arr) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: idx < arr.length - 1 ? 10 : 0, marginBottom: idx < arr.length - 1 ? 10 : 0, borderBottom: idx < arr.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{label}</div>
                      {result && !result.error && (
                        <div style={{ fontSize: 11, color: result.done ? C.green : C.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {result.done ? '✓ ' : '⏳ '}{resultText(result)}
                        </div>
                      )}
                      {result?.error && <div style={{ fontSize: 11, color: C.red, marginTop: 2 }}>✗ {result.error}</div>}
                    </div>
                    {running
                      ? <button style={{ ...S.btn('danger'), padding: '6px 14px', fontSize: 12 }} onClick={onCancel}>Cancel</button>
                      : <button style={{ ...S.btn('secondary'), padding: '6px 14px', fontSize: 12, opacity: !ebayConnected ? 0.6 : 1 }} onClick={onRun} disabled={!ebayConnected}>Run</button>
                    }
                  </div>
                ))}
              </div>
              {!ebayConnected && <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Connect eBay above to enable.</div>}
            </Section>

            {/* Reconcile */}
            <ReconcileSection />
          </div>{/* end right column */}
        </div>
      )}
    </div>
  )
}
