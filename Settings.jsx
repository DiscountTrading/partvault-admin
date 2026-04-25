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
const EBAY_OAUTH_URL = `https://auth.ebay.com/oauth2/authorize?client_id=${EBAY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(EBAY_RUNAME)}&scope=${encodeURIComponent('https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances')}`
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

  // eBay state
  const [ebayCreds, setEbayCreds] = useState({ appId: EBAY_CLIENT_ID, certId: '', ruName: EBAY_RUNAME })
  const [showCert, setShowCert] = useState(false)
  const [ebayConnected, setEbayConnected] = useState(false)
  const [ebayExpiry, setEbayExpiry] = useState(null)
  const [ebayTesting, setEbayTesting] = useState(false)
  const [ebayTestResult, setEbayTestResult] = useState(null)
  const [credsSaving, setCredsSaving] = useState(false)
  const [credsSaved, setCredsSaved] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importJob, setImportJob] = useState(null)
  const [parsing, setParsing] = useState(false)
  const pollRef = useRef(null)

  // Reconcile state
  const [reconciling, setReconciling] = useState(false)
  const [reconcileResult, setReconcileResult] = useState(null)
  const [reconcileError, setReconcileError] = useState(null)
  const [retrying, setRetrying] = useState(false)
  const [retryResult, setRetryResult] = useState(null)
  const [clearingFlag, setClearingFlag] = useState(null) // partId being cleared
  const oauthExchangeRef = useRef(false) // v2.3.2: guard against double-exchange

useEffect(() => {
    loadSettings()
    if (!storeId) return
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code && !oauthExchangeRef.current) {
      oauthExchangeRef.current = true // v2.3.2: latch BEFORE async work
      // Clear the URL FIRST so any re-render of this effect cannot re-read the code
      window.history.replaceState({}, '', window.location.pathname + '#settings-ebay')
      setTab('ebay')
      handleOAuthCallback(code)
    }
  }, [storeId])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const loadSettings = async () => {
    if (!storeId) return
    try {
      const { data } = await sb.from('stores').select('settings').eq('id', storeId).single()
      if (data?.settings) {
        if (data.settings.footer) setFooter(data.settings.footer)
        if (data.settings.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
        if (data.settings.ebayCreds) setEbayCreds(c => ({ ...c, ...data.settings.ebayCreds }))
        if (data.settings.ebayOAuth?.accessToken) {
          setEbayConnected(true)
          setEbayExpiry(data.settings.ebayOAuth.expiresAt)
        }
      }
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
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const merged = { ...(current?.settings || {}), ebayCreds }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      setCredsSaved(true)
      setTimeout(() => setCredsSaved(false), 2000)
    } catch (e) {
      console.error('Save creds failed', e)
    }
    setCredsSaving(false)
  }

    const handleOAuthCallback = async (code) => {
    try {
      // v2.3.2: Pull credentials directly from DB rather than React state, because
      // ebayCreds state may not yet be hydrated when the OAuth redirect lands.
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const savedCreds = current?.settings?.ebayCreds || {}
      const appId = savedCreds.appId || ebayCreds.appId || EBAY_CLIENT_ID
      const certId = savedCreds.certId || ebayCreds.certId
      const ruName = savedCreds.ruName || ebayCreds.ruName || EBAY_RUNAME
 
      if (!certId) throw new Error('Cert ID missing — please save credentials first')
 
      const res = await fetch(`${CLOUDFLARE_PROXY}/ebay/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, appId, certId, ruName }), // v2.3.2: was missing appId + ruName
      })
      const tokens = await res.json()
      if (!tokens.access_token) {
        throw new Error(tokens.error_description || tokens.error || 'No token returned')
      }
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      const ebayOAuth = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        expiresIn: tokens.expires_in,
        connectedAt: new Date().toISOString(),
      }
      const merged = { ...(current?.settings || {}), ebayOAuth, ebayCreds: { appId, certId, ruName } }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      setEbayConnected(true)
      setEbayExpiry(expiresAt)
      setEbayCreds({ appId, certId, ruName })
      setEbayTestResult({ ok: true, msg: 'Connected to eBay successfully!' })
    } catch (e) {
      console.error('OAuth callback failed', e)
      setEbayTestResult({ ok: false, msg: `Connection failed: ${e.message}` })
      // v2.3.2: reset the ref so user can retry without page reload
      oauthExchangeRef.current = false
    }
  }

  const connectEbay = () => {
    if (!ebayCreds.certId) {
      setEbayTestResult({ ok: false, msg: 'Please enter your Cert ID first and save credentials.' })
      return
    }
    window.location.href = EBAY_OAUTH_URL
  }

  const disconnectEbay = async () => {
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const merged = { ...(current?.settings || {}), ebayOAuth: null }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      setEbayConnected(false)
      setEbayExpiry(null)
      setEbayTestResult(null)
    } catch (e) {
      console.error('Disconnect failed', e)
    }
  }

  const testEbayConnection = async () => {
    setEbayTesting(true)
    setEbayTestResult(null)
    try {
      const { data: store } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const token = store?.settings?.ebayOAuth?.accessToken
      if (!token) throw new Error('No token — please reconnect')
      const res = await fetch(`${CLOUDFLARE_PROXY}/ebay/trading`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml', 'Authorization': `Bearer ${token}`,
          'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling', 'X-EBAY-API-APP-NAME': ebayCreds.appId,
          'X-EBAY-API-CERT-NAME': ebayCreds.certId, 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-SITEID': '15',
        },
        body: `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ActiveList><Include>true</Include><Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination></ActiveList></GetMyeBaySellingRequest>`,
      })
      const text = await res.text()
      if (text.includes('Success') || text.includes('TotalNumberOfEntries')) {
        const match = text.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/)
        const count = match ? match[1] : '?'
        setEbayTestResult({ ok: true, msg: `Connected — ${count} active listings found` })
      } else if (text.includes('Invalid access token')) {
        setEbayTestResult({ ok: false, msg: 'Token expired — please reconnect' })
        setEbayConnected(false)
      } else {
        setEbayTestResult({ ok: false, msg: 'Unexpected response from eBay' })
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
      setImportJob({ status: 'running', current_item: 'Starting...', total_ids: data.totalIds, imported_count: 0, skipped_count: 0, failed_count: 0, id: jobId })

      // Step 2: repeatedly call process_chunk until complete or cancelled
      const processNext = async () => {
        // Check for cancellation via Supabase
        const { data: jobCheck } = await sb.from('import_jobs').select('status').eq('id', jobId).single()
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
            imported_count: chunk.imported,
            skipped_count: chunk.skipped,
            failed_count: chunk.failed,
            batch_offset: chunk.offset,
            total_ids: chunk.total,
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

  const cancelImport = async () => {
    if (!importJob?.id) return
    // Mark cancelled in Supabase — processNext loop checks this before each chunk
    await sb.from('import_jobs').update({ status: 'cancelled' }).eq('id', importJob.id)
    setImporting(false)
    setImportJob(j => ({ ...j, status: 'cancelled' }))
  }

  // ─── RECONCILE ───────────────────────────────────────────────────────────
  const runReconcile = async () => {
    setReconciling(true)
    setReconcileResult(null)
    setReconcileError(null)
    setRetryResult(null)
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile', storeId }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setReconcileResult(data)
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

  const clearStaleFlag = async (partId) => {
    setClearingFlag(partId)
    try {
      await sb.from('parts').update({ reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', partId)
      setReconcileResult(r => ({
        ...r,
        staleParts: r.staleParts.filter(p => p.id !== partId),
        staleCount: r.staleCount - 1,
      }))
    } catch (e) {
      console.error('Clear flag failed', e)
    }
    setClearingFlag(null)
  }

  const parseMakeModelYear = async () => {
    setParsing(true)
    try {
      const apiKey = localStorage.getItem('pv_api_key')
      if (!apiKey) { alert('No Anthropic API key saved. Set it in localStorage as pv_api_key.'); setParsing(false); return }
      const { data: parts } = await sb.from('parts').select('id,title,make,model,year').eq('store_id', storeId).is('make', null).limit(10)
      if (!parts?.length) { alert('No unprocessed parts found.'); setParsing(false); return }
      for (const part of parts) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 200,
            messages: [{ role: 'user', content: `Extract make, model, and year range from this eBay car parts listing title. Return JSON only: {"make":"","model":"","year_from":null,"year_to":null}\n\nTitle: ${part.title}` }]
          })
        })
        const d = await res.json()
        const text = d.content?.[0]?.text || '{}'
        try {
          const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
          await sb.from('parts').update({ make: parsed.make || null, model: parsed.model || null, year_from: parsed.year_from || null, year_to: parsed.year_to || null }).eq('id', part.id)
        } catch {}
        await new Promise(r => setTimeout(r, 300))
      }
      alert(`Processed ${parts.length} parts.`)
    } catch (e) {
      alert(`Parse failed: ${e.message}`)
    }
    setParsing(false)
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
    const total = importJob.total_ids || 0
    const done = (importJob.imported_count || 0) + (importJob.skipped_count || 0)
    return total > 0 ? Math.round((done / total) * 100) : 0
  })() : 0

  // ─── RECONCILE SECTION COMPONENT ─────────────────────────────────────────
  const ReconcileSection = () => (
    <>
      <Section title="🔄 Reconcile with eBay">
        <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
          Compares your live eBay active listings against PartVault. Stale parts (Listed in PartVault but gone from eBay) are flagged for your review — nothing is changed automatically.
        </p>

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
              <StatCard label="PartVault Listed" value={reconcileResult.pvListedCount} color={C.accent} />
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
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f4f0' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>SKU / Item ID</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: C.muted, fontWeight: 600 }}>Title</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center', color: C.muted, fontWeight: 600 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconcileResult.staleParts.map((p, i) => (
                        <tr key={p.id} style={{ borderTop: i > 0 ? `1px solid ${C.border}` : 'none', background: '#fff' }}>
                          <td style={{ padding: '8px 12px', color: C.muted, fontFamily: 'monospace', fontSize: 12 }}>{p.sku}</td>
                          <td style={{ padding: '8px 12px', color: C.text }}>{p.title?.substring(0, 60)}{p.title?.length > 60 ? '…' : ''}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                            <button
                              onClick={() => clearStaleFlag(p.id)}
                              disabled={clearingFlag === p.id}
                              style={{ ...S.btn('secondary'), fontSize: 11, padding: '4px 10px', opacity: clearingFlag === p.id ? 0.5 : 1 }}
                            >
                              {clearingFlag === p.id ? '...' : 'Clear Flag'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
                  These parts may have been sold, ended, or deleted on eBay. Review each one and update the status manually in the Parts tab.
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
          style={{ ...S.btn('primary'), width: '100%', marginTop: reconcileResult ? 12 : 0, opacity: (reconciling || !ebayConnected) ? 0.6 : 1 }}
          onClick={runReconcile}
          disabled={reconciling || !ebayConnected}
        >
          {reconciling ? '⏳ Reconciling...' : reconcileResult ? '↺ Run Again' : '🔄 Run Reconcile'}
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
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...S.input, paddingRight: 60 }}
                  type={showCert ? 'text' : 'password'}
                  value={ebayCreds.certId}
                  onChange={e => setEbayCreds(c => ({ ...c, certId: e.target.value }))}
                  placeholder="Cert ID"
                />
                <button onClick={() => setShowCert(s => !s)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: C.muted, fontSize: 12 }}>
                  {showCert ? 'Hide' : 'Show'}
                </button>
              </div>
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
                  {ebayConnected ? 'Connected to eBay' : 'Not connected'}
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
                <button style={{ ...S.btn('primary'), flex: 1 }} onClick={connectEbay}>Connect eBay</button>
              )}
            </div>
          </Section>

          {/* Parse with AI */}
          <Section title="🤖 Parse with AI">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Extracts make, model and year from listing titles. Processes unparsed listings in batches of 10. Requires your Anthropic API key saved in the browser.
            </p>
            <button style={{ ...S.btn('primary'), width: '100%', opacity: parsing ? 0.6 : 1 }} onClick={parseMakeModelYear} disabled={parsing}>
              {parsing ? '⏳ Parsing...' : '🔍 Parse Make / Model / Year'}
            </button>
          </Section>

          </div>{/* end left column */}

          {/* RIGHT COLUMN */}
          <div>
            {/* Import */}
            <Section title="📥 eBay Import">
              <p style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
                Pulls all listings — active, sold and withdrawn. Already-imported listings are skipped automatically. Runs in the background.
              </p>

              {importJob && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: C.text, fontWeight: 500 }}>{importJob.current_item || 'Processing...'}</span>
                    <span style={{ color: C.muted }}>{(importJob.imported_count || 0) + (importJob.skipped_count || 0)}/{importJob.total_ids || '?'}</span>
                  </div>
                  <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${importProgress}%`, background: importJob.status === 'completed' ? C.green : C.accent, borderRadius: 4, transition: 'width 0.5s' }} />
                  </div>
                  {importJob.skipped_count > 0 && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{importJob.skipped_count} already imported — skipped</div>}
                  {importJob.status === 'failed' && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>Error: {importJob.error_message}</div>}
                  {importJob.status === 'completed' && <div style={{ fontSize: 12, color: C.green, marginTop: 4 }}>✓ Import complete — {importJob.imported_count} parts imported</div>}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ ...S.btn('primary'), flex: 1, opacity: (importing || !ebayConnected) ? 0.6 : 1 }} onClick={importAllListings} disabled={importing || !ebayConnected}>
                  {importing ? '⏳ Importing...' : '📥 Import All eBay Listings'}
                </button>
                {importing && <button style={{ ...S.btn('danger') }} onClick={cancelImport}>Cancel</button>}
              </div>
              {!ebayConnected && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Connect eBay above to enable import.</div>}
            </Section>

            {/* Reconcile */}
            <ReconcileSection />
          </div>{/* end right column */}
        </div>
      )}
    </div>
  )
}
