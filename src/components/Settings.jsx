import { useState, useEffect, useRef, useCallback } from 'react'
import { C, S, fmt, APP_VERSION, DEFAULT_POSTAGE_TIERS, defaultPostageTiers, DEFAULT_AGED_THRESHOLD_DAYS, DEFAULT_AGE_BRACKETS, rentPerDay } from '../lib/constants'
import { printLabels, DEFAULT_LABELS } from '../lib/labels'
import { sb } from '../lib/supabase'
import { buildSkuPreview, SKU_TOKENS, DEFAULT_SKU_TEMPLATE, DEFAULT_SKU_PAD } from '../lib/sku'
import { MARKETPLACES, MARKETPLACE_LIST } from '../lib/marketplaces'
import { planState } from '../lib/plan'
import { startCheckout, openBillingPortal } from '../lib/billing'
import TeamAccess from './TeamAccess'
import Activity from './Activity'
import { compressImage } from '../lib/image'
import ShippingSettings from './ShippingSettings'
import WarehouseMap from './WarehouseMap'
import ContainerManager from './ContainerManager'
import { WAREHOUSE_DEFAULTS } from '../lib/warehouse'
import EbayHistoryUpload from './EbayHistoryUpload'
import HistoricalCosts from './HistoricalCosts'
import SkuReconcile from './SkuReconcile'

// Small inline %/$ (or rate) toggle used on the costing fields.
function ModeToggle({ mode, onChange, opts }) {
  return (
    <span style={{ display: 'inline-flex', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', marginLeft: 8, verticalAlign: 'middle' }}>
      {opts.map(([val, lbl]) => (
        <button key={val} type="button" onClick={() => onChange(val)}
          style={{ padding: '1px 8px', fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', background: mode === val ? C.accent : '#fff', color: mode === val ? '#fff' : C.muted }}>{lbl}</button>
      ))}
    </span>
  )
}

// Vertical-neutral starting template — each store edits this to its own wording.
// (Must NOT assume auto parts or name a specific business; PartVault is multi-store.)
const DEFAULT_FOOTER = `All photos are of the exact item you will receive — no stock images. Items are sold as described, so please review the photos and details, and message us with any questions before you buy.
We post promptly and provide tracking through eBay once your order is on its way.
Thanks for shopping with us — we'll always do our best to make sure you're happy with your purchase.`

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

export default function Settings({ profile, storeId, onSignOut, refreshStores, onSettingsSaved, parts = [], onChanged }) {
  const [tab, setTab] = useState('account')
  const [footer, setFooter] = useState(DEFAULT_FOOTER)
  // eBay listing defaults applied at publish time (warranty aspect + condition
  // description blurb). Duration is always GTC for fixed-price listings.
  const [listingDefaults, setListingDefaults] = useState({ warranty: '', conditionDescription: '' })
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS)
  const [captureAssess, setCaptureAssess] = useState({ category: true, price: true })
  const [costing, setCosting] = useState({ labourRate: 60, adminPct: 10, adminMin: 5, baseCostPct: 25, handlingFee: 2, postageDefaultG: 1000, postageTiers: DEFAULT_POSTAGE_TIERS, labourMode: 'fixed', adminMode: 'percent', adminMinMode: 'fixed', baseCostMode: 'percent' })
  const [inventory, setInventory] = useState({ agedThresholdDays: DEFAULT_AGED_THRESHOLD_DAYS, ageBrackets: DEFAULT_AGE_BRACKETS })
  const [storage, setStorage] = useState({ volumeM3: '', rent: '', rentPeriod: 'monthly', usablePct: 25 })
  const [warehouse, setWarehouse] = useState(WAREHOUSE_DEFAULTS)
  const [labels, setLabels] = useState(DEFAULT_LABELS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)


  // SKU format (stored in stores.sku_format_config, NOT settings)
  const [skuTemplate, setSkuTemplate] = useState(DEFAULT_SKU_TEMPLATE)
  const [skuPad, setSkuPad] = useState(DEFAULT_SKU_PAD)
  const [skuSaving, setSkuSaving] = useState(false)
  const [skuSaved, setSkuSaved] = useState(false)

  // Marketing images — store-wide standard images added to every eBay listing
  const [marketingImages, setMarketingImages] = useState([])
  const [mktUploading, setMktUploading] = useState(false)
  const mktFileRef = useRef()

  // eBay state
  // (App ID / Cert ID / RuName are platform-level config held server-side in the
  //  edge function — not customer-editable, so no credential state lives here.)
  const [ebayConnected, setEbayConnected] = useState(false)
  const [ebayExpiry, setEbayExpiry] = useState(null)
  const [ebayUsername, setEbayUsername] = useState(null)
  const [ebayUsernameStatus, setEbayUsernameStatus] = useState(null) // 'loading' | 'error' | null
  const [ebayUsernameError, setEbayUsernameError] = useState(null)
  const [ebayNeedsReconnect, setEbayNeedsReconnect] = useState(false)
  const [shipAddress, setShipAddress] = useState({ addressLine1: '', city: '', stateOrProvince: '', postalCode: '', country: 'AU' })
  const [ebayLocationKey, setEbayLocationKey] = useState(null)
  const [savingLocation, setSavingLocation] = useState(false)
  const [locationMsg, setLocationMsg] = useState(null)
  const [ebayTesting, setEbayTesting] = useState(false)
  const [ebayTestResult, setEbayTestResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [importJob, setImportJob] = useState(null)
  const [showAdvSync, setShowAdvSync] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncPhase, setSyncPhase] = useState('')
  const [syncStatus, setSyncStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [lastRun, setLastRun] = useState({})
  useEffect(() => { try { setLastRun(JSON.parse(localStorage.getItem(`pv_lastrun_${storeId}`) || '{}')) } catch { setLastRun({}) } }, [storeId])
  // Record when an import step last finished (per store), shown next to each.
  const markRun = (op) => {
    try {
      const cur = JSON.parse(localStorage.getItem(`pv_lastrun_${storeId}`) || '{}')
      cur[op] = new Date().toISOString()
      localStorage.setItem(`pv_lastrun_${storeId}`, JSON.stringify(cur))
      setLastRun(cur)
    } catch { /* ignore */ }
  }
  const fmtLastRun = (iso) => iso ? `last run ${new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'not run yet'
  // Nightly auto-sync state lives server-side in sync_runs (written by pg_cron),
  // so the manual lastRun (localStorage) never reflects it. Read it directly.
  const [nightly, setNightly] = useState(null)
  const [lastSync, setLastSync] = useState(null) // most recent sync of ANY kind (manual or nightly)
  const fetchNightly = useCallback(async () => {
    if (!storeId) return
    const { data } = await sb.from('sync_runs').select('phase, detail, done, updated_at')
      .eq('store_id', storeId).order('updated_at', { ascending: false }).limit(1).maybeSingle()
    setNightly(data || null)
    const { data: ls } = await sb.rpc('get_last_sync', { p_store_id: storeId })
    setLastSync(Array.isArray(ls) ? (ls[0] || null) : (ls || null))
  }, [storeId])
  useEffect(() => { fetchNightly() }, [fetchNightly])
  // Store timezone — drives the nightly sync schedule (local midnight) and the
  // default sales-match window. Captured from the browser on first load, editable.
  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } })()
  const tzList = (() => { try { return Intl.supportedValuesOf('timeZone') } catch { return [browserTz, 'UTC'] } })()
  const [timezone, setTimezone] = useState(browserTz)
  const [tzSaved, setTzSaved] = useState(false)
  const saveTimezone = async (tz) => {
    setTimezone(tz)
    if (!storeId) return
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      await sb.from('stores').update({ settings: { ...(current?.settings || {}), timezone: tz } }).eq('id', storeId)
      setTzSaved(true); setTimeout(() => setTzSaved(false), 2000)
    } catch (e) { console.error('Timezone save failed', e) }
  }
  // Auto-sync interval (hours) — how often the full eBay sync runs. 24 = nightly
  // (default); minimum 3h to stay well within eBay's API limits.
  const [syncInterval, setSyncInterval] = useState(24)
  const [siSaved, setSiSaved] = useState(false)
  const saveSyncInterval = async (h) => {
    const v = +h || 24
    setSyncInterval(v)
    if (!storeId) return
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      await sb.from('stores').update({ settings: { ...(current?.settings || {}), syncIntervalHours: v } }).eq('id', storeId)
      setSiSaved(true); setTimeout(() => setSiSaved(false), 2000)
    } catch (e) { console.error('Sync interval save failed', e) }
  }
  // AI model tier — quality vs credit cost per part (economy/standard/premium).
  const [aiModel, setAiModel] = useState('standard')
  const [amSaved, setAmSaved] = useState(false)
  const saveAiModel = async (m) => {
    setAiModel(m)
    if (!storeId) return
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      await sb.from('stores').update({ settings: { ...(current?.settings || {}), aiModel: m } }).eq('id', storeId)
      setAmSaved(true); setTimeout(() => setAmSaved(false), 2000)
    } catch (e) { console.error('AI model save failed', e) }
  }
  // Subscription plan + this month's AI usage (usage metered server-side).
  const [plan, setPlan] = useState(() => planState(null))
  const [aiUsage, setAiUsage] = useState(null)
  const [aiCredits, setAiCredits] = useState(null)
  const [showPlans, setShowPlans] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [previewCustomer, setPreviewCustomer] = useState(false) // founder: preview the customer billing UI
  const showBilling = !plan.founder || previewCustomer
  const PLAN_CADENCES = [
    { id: 'monthly',        label: 'Monthly (cancel anytime)', price: { basic: '$29', pro: '$79', business: '$129' }, suffix: '/mo' },
    { id: 'annual_monthly', label: '12-month (paid monthly)',  price: { basic: '$19', pro: '$59', business: '$99' },  suffix: '/mo' },
    { id: 'annual_upfront', label: '12-month (paid upfront, +2 months free)', price: { basic: '$228', pro: '$708', business: '$1,188' }, suffix: '/yr' },
  ]
  const buy = async (fn) => { setBillingBusy(true); try { await fn() } catch (e) { alert(e.message) } setBillingBusy(false) }
  // Store deletion / recovery
  const [storeName, setStoreName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [nameMsg, setNameMsg] = useState('')
  const [myRole, setMyRole] = useState('')
  const [deletedStores, setDeletedStores] = useState([])
  const [delConfirm, setDelConfirm] = useState('')
  const isOwner = myRole === 'owner'

  // Marketplace (country) — set at store creation, locked once parts exist
  // (DB trigger enforces it; the UI just explains).
  const [marketplace, setMarketplace] = useState('EBAY_AU')
  const [mpLocked, setMpLocked] = useState(true) // assume locked until the part count loads
  const [mpSaved, setMpSaved] = useState(false)
  const saveMarketplace = async (mp) => {
    const prev = marketplace
    setMarketplace(mp)
    try {
      const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const { error } = await sb.from('stores').update({ settings: { ...(current?.settings || {}), marketplace: mp } }).eq('id', storeId)
      if (error) throw error
      setMpSaved(true); setTimeout(() => setMpSaved(false), 2000)
    } catch (e) {
      setMarketplace(prev) // DB trigger rejects the change once parts exist
      alert(e.message || 'Marketplace could not be changed')
    }
  }
  const [salesMatch, setSalesMatch] = useState(null)
  const [salesMatchLoading, setSalesMatchLoading] = useState(false)
  // Sales-match window (local calendar dates, interpreted in the browser's TZ so
  // they line up with eBay Seller Hub's local report dates). Default: last 90 days.
  const toYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const [smFrom, setSmFrom] = useState(toYmd(new Date(Date.now() - 90 * 86400000)))
  const [smTo, setSmTo] = useState(toYmd(new Date()))
  const checkSalesMatch = async () => {
    setSalesMatchLoading(true); setSalesMatch(null)
    try {
      const { data: { session } } = await sb.auth.getSession()
      // Build local-midnight bounds; .toISOString() converts to UTC (DST-correct).
      const fromIso = new Date(`${smFrom}T00:00:00`).toISOString()
      const toIso   = new Date(`${smTo}T23:59:59`).toISOString()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'sales_match', storeId, fromDate: fromIso, toDate: toIso }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Sales match failed')
      setSalesMatch(d)
    } catch (e) { setSalesMatch({ error: e.message }) }
    setSalesMatchLoading(false)
  }
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState(null)
  const backfillCancelRef = useRef(false)
  const [importingHistory, setImportingHistory] = useState(false)
  const [historyResult, setHistoryResult] = useState(null)
  const historyCancelRef = useRef(false)
  const [backfillingCats, setBackfillingCats] = useState(false)
  const [backfillCatResult, setBackfillCatResult] = useState(null)
  const backfillCatCancelRef = useRef(false)
  const [backfillingDates, setBackfillingDates] = useState(false)
  const [backfillDateResult, setBackfillDateResult] = useState(null)
  const backfillDateCancelRef = useRef(false)
  const [parsing, setParsing] = useState(false)
  const [parseProgress, setParseProgress] = useState(null) // { processed, total, failed }
  const parseCancelRef = useRef(false)
  const pollRef = useRef(null)
  const reconcileRef = useRef(null) // scroll target for "Review & resolve"

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
    // Reset per-store state first so a previous store's values can't bleed
    // through when switching stores (the load below only sets values that exist).
    setFooter(DEFAULT_FOOTER)
    setAiSettings(DEFAULT_AI_SETTINGS)
    setShipAddress({ addressLine1: '', city: '', stateOrProvince: '', postalCode: '', country: 'AU' })
    setEbayLocationKey(null)
    setEbayConnected(false)
    setEbayExpiry(null)
    setEbayUsername(null)
    setEbayUsernameStatus(null)
    setEbayUsernameError(null)
    setEbayNeedsReconnect(false)
    setEbayTestResult(null)
    setSkuTemplate(DEFAULT_SKU_TEMPLATE)
    setSkuPad(DEFAULT_SKU_PAD)
    setMarketingImages([])
    try {
      const { data } = await sb.from('stores').select('settings, sku_format_config, plan, name, join_code').eq('id', storeId).single()
      setPlan(planState(data?.plan))
      setStoreName(data?.name || '')
      setJoinCode(data?.join_code || '')
      sb.auth.getUser().then(({ data: u }) => {
        if (u?.user) sb.from('store_members').select('role').eq('store_id', storeId).eq('user_id', u.user.id).maybeSingle().then(({ data: m }) => setMyRole(m?.role || ''))
      })
      sb.rpc('get_my_deleted_stores').then(({ data: d }) => setDeletedStores(d || []))
      sb.from('ai_usage').select('full_count, light_count').eq('store_id', storeId).eq('month', new Date().toISOString().slice(0, 7)).maybeSingle()
        .then(({ data: u }) => setAiUsage(u || { full_count: 0, light_count: 0 }))
      sb.from('ai_credits').select('balance').eq('store_id', storeId).maybeSingle()
        .then(({ data: c }) => setAiCredits(c?.balance ?? 0))
      if (data?.sku_format_config) {
        if (data.sku_format_config.template) setSkuTemplate(data.sku_format_config.template)
        if (data.sku_format_config.seqPad) setSkuPad(data.sku_format_config.seqPad)
      }
      if (data?.settings) {
        if (data.settings.footer) setFooter(data.settings.footer)
        if (data.settings.listingDefaults) setListingDefaults(s => ({ ...s, ...data.settings.listingDefaults }))
        if (data.settings.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
        if (data.settings.captureAssess) setCaptureAssess(s => ({ ...s, ...data.settings.captureAssess }))
        if (data.settings.costing) setCosting(s => ({ ...s, ...data.settings.costing }))
        // No saved postage tiers → default to THIS store's marketplace rates
        // (not AU) so cost estimates start sensible for US/UK/CA.
        if (!data.settings.costing?.postageTiers?.length) setCosting(s => ({ ...s, postageTiers: defaultPostageTiers() }))
        if (data.settings.inventory) setInventory(s => ({ ...s, ...data.settings.inventory }))
        if (data.settings.storage) setStorage(s => ({ ...s, ...data.settings.storage }))
        if (data.settings.warehouse) setWarehouse(s => ({ ...s, ...data.settings.warehouse }))
        if (data.settings.labels) setLabels(s => ({ ...s, ...data.settings.labels }))
        if (data.settings.shipAddress) setShipAddress(a => ({ ...a, ...data.settings.shipAddress }))
        if (data.settings.ebayLocationKey) setEbayLocationKey(data.settings.ebayLocationKey)
        if (data.settings.ebayUsername) setEbayUsername(data.settings.ebayUsername) // persisted — shows immediately
        if (Array.isArray(data.settings.marketingImages)) setMarketingImages(data.settings.marketingImages)
        // Capture the browser's timezone the first time (none stored yet), so the
        // nightly sync runs at THIS store's local midnight rather than a default.
        if (data.settings.timezone) setTimezone(data.settings.timezone)
        else saveTimezone(browserTz)
        if (data.settings.syncIntervalHours) setSyncInterval(+data.settings.syncIntervalHours)
        if (data.settings.aiModel) setAiModel(data.settings.aiModel)
        setMarketplace(data.settings.marketplace || 'EBAY_AU')
      }
      // Marketplace locks once the store has any part (DB-enforced too).
      const { count: partCount } = await sb.from('parts').select('id', { count: 'exact', head: true }).eq('store_id', storeId)
      setMpLocked((partCount || 0) > 0)
      // eBay connection status — the keyset is server-side; we only need to know
      // whether this store has connected (i.e. has a valid token expiry).
      const { data: tokenRow } = await sb.from('ebay_tokens').select('expires_at').eq('store_id', storeId).maybeSingle()
      if (tokenRow?.expires_at) {
        setEbayConnected(true)
        setEbayExpiry(tokenRow.expires_at)
        refreshEbayUsername()
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
      const merged = { ...(current?.settings || {}), footer, listingDefaults, aiDescription: aiSettings, captureAssess, costing, inventory, storage, warehouse, labels, timezone }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      onSettingsSaved?.(merged) // let the app refresh costing/inventory-driven views live
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('Save failed', e)
    }
    setSaving(false)
  }

  // Warehouse settings auto-save (debounced) so toggling containers / editing the
  // grid just works — no separate Save press for this tab.
  const whTimer = useRef(null)
  const persistWarehouse = async (wh) => {
    if (!storeId) return
    try {
      const { data: cur } = await sb.from('stores').select('settings').eq('id', storeId).single()
      await sb.from('stores').update({ settings: { ...(cur?.settings || {}), warehouse: wh } }).eq('id', storeId)
      onSettingsSaved?.({ warehouse: wh })
    } catch (e) { console.error('Warehouse save failed', e) }
  }
  const updateWarehouse = (updater) => setWarehouse(prev => {
    const next = typeof updater === 'function' ? updater(prev) : updater
    clearTimeout(whTimer.current)
    whTimer.current = setTimeout(() => persistWarehouse(next), 500)
    return next
  })


  const saveSkuFormat = async () => {
    if (!storeId) return
    setSkuSaving(true)
    try {
      const { data: current } = await sb.from('stores').select('sku_format_config').eq('id', storeId).single()
      const merged = { ...(current?.sku_format_config || {}), template: skuTemplate.trim() || DEFAULT_SKU_TEMPLATE, seqPad: Number(skuPad) || DEFAULT_SKU_PAD }
      const { error } = await sb.from('stores').update({ sku_format_config: merged }).eq('id', storeId)
      if (error) throw error
      setSkuSaved(true)
      setTimeout(() => setSkuSaved(false), 2000)
    } catch (e) {
      console.error('Save SKU format failed', e)
      alert(`Failed to save SKU format: ${e.message}`)
    }
    setSkuSaving(false)
  }

  const persistMarketing = async (arr) => {
    const { data: current } = await sb.from('stores').select('settings').eq('id', storeId).single()
    await sb.from('stores').update({ settings: { ...(current?.settings || {}), marketingImages: arr } }).eq('id', storeId)
  }

  const uploadMarketing = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setMktUploading(true)
    try {
      const added = []
      for (const file of files) {
        const blob = await compressImage(file, 1400, 0.82)
        const path = `marketing/${storeId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`
        const { error } = await sb.storage.from('part-photos').upload(path, blob, { contentType: 'image/jpeg' })
        if (error) throw error
        added.push(sb.storage.from('part-photos').getPublicUrl(path).data.publicUrl)
      }
      const next = [...marketingImages, ...added]
      setMarketingImages(next)
      await persistMarketing(next)
    } catch (err) {
      alert(`Upload failed: ${err.message}`)
    }
    setMktUploading(false)
  }

  const removeMarketing = async (url) => {
    const next = marketingImages.filter(u => u !== url)
    setMarketingImages(next)
    await persistMarketing(next)
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
      refreshEbayUsername()
    } catch (e) {
      console.error('OAuth callback failed', e)
      setEbayTestResult({ ok: false, msg: `Connection failed: ${e.message}` })
    }
  }

  const saveShipAddressAndCreateLocation = async () => {
    setSavingLocation(true)
    setLocationMsg(null)
    try {
      const { addressLine1, city, stateOrProvince, postalCode, country } = shipAddress
      if (!addressLine1 || !city || !postalCode || !country) throw new Error('Please fill in address line, city, postcode, and country')

      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const newSettings = { ...(storeRow?.settings || {}), shipAddress }
      await sb.from('stores').update({ settings: newSettings }).eq('id', storeId)

      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setup_ebay_location', storeId, address: shipAddress }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to create eBay location')

      const finalSettings = { ...newSettings, ebayLocationKey: data.merchantLocationKey }
      await sb.from('stores').update({ settings: finalSettings }).eq('id', storeId)
      setEbayLocationKey(data.merchantLocationKey)
      setLocationMsg({ ok: true, msg: `eBay location created (${data.merchantLocationKey})` })
    } catch (e) {
      setLocationMsg({ ok: false, msg: e.message })
    }
    setSavingLocation(false)
  }

  const connectEbay = () => {
    // Keyset is configured server-side, so connecting is always available.
    window.location.href = EBAY_OAUTH_URL
  }

  // Translate raw eBay/edge-function errors into friendly, actionable copy.
  // Returns { text, needsReconnect } — needsReconnect drives the reconnect prompt.
  const friendlyEbayError = (raw) => {
    const r = (raw || '').toLowerCase()
    if (r.includes('scope') || r.includes('refresh failed') || r.includes('invalid_grant') ||
        r.includes('reconnect') || r.includes('expired') || r.includes('token refresh')) {
      return { text: 'Your eBay session has expired. Reconnect to keep importing and listing.', needsReconnect: true }
    }
    if (r.includes('no ebay token') || r.includes('not connected') || r.includes('no token')) {
      return { text: 'No eBay connection found. Connect your eBay account to continue.', needsReconnect: true }
    }
    if (r.includes('cert')) {
      return { text: 'Your eBay Cert ID is missing. Add it above, then reconnect.', needsReconnect: false }
    }
    if (r.includes('failed to fetch') || r.includes('networkerror')) {
      return { text: "Couldn't reach eBay just now. Check your connection and hit Refresh.", needsReconnect: false }
    }
    return { text: "Couldn't read your eBay account. Try Refresh — if it keeps failing, reconnect below.", needsReconnect: false }
  }

  // Fetch the connected eBay account's UserID and persist it so it remains visible
  // even if a later GetUser call fails (rate limit, scope, etc.).
  const refreshEbayUsername = async () => {
    if (!storeId) return
    setEbayUsernameStatus('loading')
    setEbayUsernameError(null)
    try {
      const res = await fetch(EDGE_FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_ebay_username', storeId }) })
      const d = await res.json()
      if (d.username) {
        setEbayUsername(d.username)
        setEbayUsernameStatus(null)
        setEbayUsernameError(null)
        setEbayNeedsReconnect(false)
        // Persist into stores.settings so it survives reloads and transient fetch failures
        try {
          const { data: cur } = await sb.from('stores').select('settings').eq('id', storeId).single()
          const merged = { ...(cur?.settings || {}), ebayUsername: d.username }
          await sb.from('stores').update({ settings: merged }).eq('id', storeId)
          // Surface the account name (and connection status) in the store switcher
          refreshStores?.()
        } catch (persistErr) {
          console.warn('Failed to persist eBay username', persistErr)
        }
      } else {
        const f = friendlyEbayError(d.error)
        setEbayUsernameStatus('error')
        setEbayUsernameError(f.text)
        setEbayNeedsReconnect(f.needsReconnect)
      }
    } catch (e) {
      const f = friendlyEbayError(e.message)
      setEbayUsernameStatus('error')
      setEbayUsernameError(f.text)
      setEbayNeedsReconnect(f.needsReconnect)
    }
  }

  const disconnectEbay = async () => {
    try {
      // ebay_tokens has no UPDATE policy for authenticated — must go through the
      // admin-gated SECURITY DEFINER RPC, or the write is silently denied by RLS.
      const { error: dErr } = await sb.rpc('disconnect_ebay', { p_store_id: storeId })
      if (dErr) throw dErr
      setEbayConnected(false)
      setEbayExpiry(null)
      setEbayUsername(null)
      setEbayUsernameStatus(null)
      setEbayUsernameError(null)
      setEbayNeedsReconnect(false)
      setEbayTestResult(null)
      // Clear the persisted username so a future connection can't show a stale account
      try {
        const { data: cur } = await sb.from('stores').select('settings').eq('id', storeId).single()
        if (cur?.settings?.ebayUsername) {
          const { ebayUsername: _drop, ...rest } = cur.settings
          await sb.from('stores').update({ settings: rest }).eq('id', storeId)
        }
      } catch (clearErr) {
        console.warn('Failed to clear persisted eBay username', clearErr)
      }
      // Keep the store switcher's connection status in sync
      refreshStores?.()
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

  // Returns a promise that resolves when the chunked import finishes (or
  // fails/cancels), so it can be chained in the unified "Sync with eBay" flow.
  const importAllListings = () => new Promise((resolve) => {
    setImporting(true)
    setImportJob({ status: 'starting', current_item: 'Fetching eBay listing IDs...' })
    ;(async () => {
      try {
        const res = await fetch(EDGE_FN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', storeId }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)

        const jobId = data.jobId
        setImportJob({ status: 'running', current_item: 'Starting...', total_items: data.totalIds, imported: 0, skipped: 0, failed: 0, id: jobId })

        const processNext = async () => {
          const { data: jobCheck } = await sb.from('jobs').select('status').eq('id', jobId).single()
          if (jobCheck?.status === 'cancelled') {
            setImporting(false); setImportJob(j => ({ ...j, status: 'cancelled' })); resolve(); return
          }
          try {
            const chunkRes = await fetch(EDGE_FN, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'process_chunk', jobId, storeId }),
            })
            const chunk = await chunkRes.json()
            if (chunk.error && chunk.retry) { setTimeout(processNext, 2000); return }
            if (chunk.error) throw new Error(chunk.error)

            setImportJob(j => ({
              ...j, id: jobId, status: chunk.status,
              imported: chunk.imported, skipped: chunk.skipped, failed: chunk.failed,
              batch_offset: chunk.offset, total_items: chunk.total,
              current_item: chunk.isComplete
                ? `✓ Complete — ${chunk.imported} imported, ${chunk.skipped} skipped`
                : `Processing ${chunk.offset} of ${chunk.total}...`,
            }))

            if (chunk.isComplete || chunk.status === 'completed') { markRun('import'); setImporting(false); resolve(); return }
            setTimeout(processNext, 500)
          } catch (e) {
            setImportJob(j => ({ ...j, status: 'failed', error_message: e.message })); setImporting(false); resolve()
          }
        }
        setTimeout(processNext, 300)
      } catch (e) {
        setImportJob({ status: 'failed', error_message: e.message }); setImporting(false); resolve()
      }
    })()
  })

  const runBackfill = async (daysBack = 5 * 365) => {
    backfillCancelRef.current = false
    setBackfilling(true)
    setBackfillResult(null)

    const WINDOW_DAYS = 30
    const startDate   = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
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
      markRun('backfill')
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

  const runDateBackfill = async () => {
    backfillDateCancelRef.current = false
    setBackfillingDates(true)
    setBackfillDateResult(null)
    let totalUpdated = 0, totalNoData = 0, afterId = null
    try {
      let hasMore = true
      while (hasMore && !backfillDateCancelRef.current) {
        setBackfillDateResult({ progress: true, updated: totalUpdated, noData: totalNoData })
        const res = await fetch(EDGE_FN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'backfill_listing_dates', storeId, afterId }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        totalUpdated += data.updated || 0
        totalNoData  += data.noData  || 0
        afterId = data.nextAfterId || afterId
        hasMore = data.hasMore || false
      }
      setBackfillDateResult({ done: true, cancelled: backfillDateCancelRef.current, updated: totalUpdated, noData: totalNoData })
    } catch (e) {
      setBackfillDateResult({ error: e.message, updated: totalUpdated })
    }
    setBackfillingDates(false)
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
      markRun('reconcile')
      if (data.staleListings?.length > 0) {
        await enrichStaleParts(data.staleListings)
      }
      setReconciling(false)
      return data
    } catch (e) {
      setReconcileError(e.message)
    }
    setReconciling(false)
  }

  // Jump from the out-of-sync banner straight to resolution: reveal the Reconcile
  // section, run it (lists stale items + fetches each one's eBay status with a
  // suggested action), and scroll to it.
  const openReconcile = async () => {
    setShowAdvSync(true)
    setTimeout(() => reconcileRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    if (!reconciling) runReconcile()
  }

  // Lightweight live check: how many parts are out of step with eBay.
  const checkSyncStatus = async () => {
    setStatusLoading(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'sync_status', storeId }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Check failed')
      setSyncStatus(d)
      try { localStorage.setItem(`pv_syncstatus_${storeId}`, JSON.stringify({ result: d, checkedAt: d.checkedAt || new Date().toISOString() })) } catch { /* ignore */ }
    } catch (e) { setSyncStatus({ error: e.message }) }
    setStatusLoading(false)
  }
  // Auto-check on opening the eBay tab, but at most once every 6h — show the
  // cached result if it's still fresh (the ↻ Re-check button forces a refresh).
  const SYNC_STATUS_TTL_MS = 6 * 60 * 60 * 1000
  useEffect(() => {
    if (tab !== 'ebay' || !ebayConnected || !storeId) return
    try {
      const cached = JSON.parse(localStorage.getItem(`pv_syncstatus_${storeId}`) || 'null')
      if (cached?.checkedAt && Date.now() - new Date(cached.checkedAt).getTime() < SYNC_STATUS_TTL_MS) {
        setSyncStatus(cached.result); return
      }
    } catch { /* ignore */ }
    checkSyncStatus()
  }, [tab, ebayConnected, storeId])

  // POST an edge action, transparently retrying transient rate-limits. Surfaces
  // the real error message (edge uses `error`; the gateway/proxy uses `message`)
  // instead of a generic fallback, and respects a Retry-After hint when present.
  const callEdge = async (payload, label) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let d = {}
      try { d = await res.json() } catch { /* non-JSON body */ }
      const errMsg = d.error || d.message || (!res.ok ? `HTTP ${res.status}` : null)
      const rateLimited = res.status === 429 || /rate limit|retry after|throttl/i.test(errMsg || '')
      if (rateLimited && attempt < 3) {
        const m = /(\d{3,})\s*ms/.exec(errMsg || '')
        const wait = Math.min(m ? +m[1] : 0, 8000) || (1500 * (attempt + 1))
        await sleep(wait)
        continue
      }
      if (!res.ok || d.error) throw new Error(`${label}: ${errMsg || 'failed'}`)
      return d
    }
    throw new Error(`${label}: still rate-limited after retries — wait a minute and try again`)
  }

  // One-click full sync: import new listings → update sold orders (last ~4
  // months) → reconcile against eBay. Each step shows its own progress below.
  // Order-complete sold import via eBay getOrders (matches Seller Hub exactly).
  const runSoldOrders = async (days = 120) => {
    let created = 0, updated = 0, skipped = 0, failed = 0
    const failedReasons = []
    let startOffset = 0, ebayOrders = 0
    do {
      const d = await callEdge({ action: 'import_sold_orders', storeId, days, startOffset }, 'Sold-orders import')
      created += d.created || 0
      updated += d.updated || 0
      skipped += d.skipped || 0
      failed  += d.failed  || 0
      if (d.failedReasons) failedReasons.push(...d.failedReasons)
      ebayOrders = d.ebayOrders || ebayOrders
      startOffset = d.nextOffset || 0
      if (!d.hasMore) break
    } while (startOffset < 5000)
    markRun('backfill')
    return { created, updated, skipped, failed, failedReasons, ebayOrders }
  }

  const runFees = async (days = 120) => callEdge({ action: 'import_fees', storeId, days }, 'Fee import')
  // Fees are secondary to listings/sold/reconcile and eBay's Finances API throws
  // intermittent 500s — never let a fee hiccup abort the whole sync.
  const runFeesSafe = async (days = 120) => {
    try { return await runFees(days) }
    catch (e) { return { feeTotal: 0, ordersMatched: 0, feesFailed: true, feeError: e.message } }
  }

  // Write one summary line per manual sync into the audit log (Activity view).
  const logSync = async (summary, data = {}) => {
    try {
      await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'log_sync', storeId, summary, data }),
      })
      fetchNightly()
    } catch { /* best-effort */ }
  }

  // One-click "Sync now" — drives the SAME server-side resumable pipeline the
  // nightly cron uses (action: cron_sync, manual:true). It POSTs repeatedly to
  // advance the run and reads the shared sync_runs row for live progress. Because
  // the work happens server-side, the sync keeps going — and a later nightly tick
  // resumes it — even if this tab is closed. It is 100% READ-ONLY against eBay
  // (see cron_sync): no listing is ever created, revised, or ended.
  const runSync = async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    // Progress bands per phase. Import dominates (thousands of listings) so it gets
    // the widest band; the rest are quick. hi is never quite reached until the next
    // phase begins, so the bar keeps moving without ever hitting 100 early.
    const PHASE = {
      import:    { lo: 4,  hi: 62, label: 'Importing listings from eBay…' },
      backfill:  { lo: 62, hi: 80, label: 'Importing sold orders…' },
      fees:      { lo: 80, hi: 90, label: 'Importing eBay fees…' },
      reconcile: { lo: 90, hi: 99, label: 'Reconciling with eBay…' },
    }
    setSyncingAll(true)
    setSyncPhase('Starting sync…')
    setImportJob({ status: 'running', current_item: 'Starting…' })
    setDisplayProgress(2); setRpm(55)

    // `target` is the real progress (set by the poller); the animator eases the
    // displayed value toward it every frame so the bar always glides — never sits
    // frozen during a 110s server call, never jumps between phases.
    let target = 2
    let done   = false

    const anim = setInterval(() => {
      setDisplayProgress(prev => prev < target
        ? Math.min(target, prev + Math.max(0.5, (target - prev) * 0.1))
        : prev)
      setRpm(done ? 0 : 52 + Math.floor(Math.random() * 26)) // lively tacho
    }, 120)

    // Poll the shared run row often (cron_sync writes detail ~every 18s server-side)
    // and translate phase + "X/Y" into a monotonic target. Phases without a count
    // creep slowly across their band so the bar keeps advancing.
    const poll = setInterval(async () => {
      try {
        const { data: run } = await sb.from('sync_runs')
          .select('phase, detail').eq('store_id', storeId)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle()
        if (!run) return
        const p = PHASE[run.phase] || { lo: 4, hi: 99, label: 'Working…' }
        const m = /(\d+)\s*\/\s*(\d+)/.exec(run.detail || '')
        const t = (m && +m[2] > 0)
          ? p.lo + (p.hi - p.lo) * Math.min(1, +m[1] / +m[2])
          : Math.min(p.hi - 1, Math.max(target, p.lo) + 1.2) // slow creep
        target = Math.max(target, t) // never go backward
        setSyncPhase(`${p.label}${run.detail ? ` · ${run.detail}` : ''}`)
      } catch { /* transient — try again next tick */ }
    }, 2000)

    try {
      let guard = 0
      while (!done && guard++ < 600) {
        let d
        try {
          const res = await fetch(EDGE_FN, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cron_sync', storeId, manual: true }),
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
      setSyncPhase('✓ Sync complete')
      setImportJob(j => ({ ...j, status: 'completed', current_item: '✓ Sync complete' }))
      markRun('import'); markRun('backfill'); markRun('reconcile')
      await fetchNightly()
      await checkSyncStatus() // auto-refresh the status panel — no manual re-check needed
    } catch (e) {
      setSyncPhase(`Sync stopped: ${e.message}`)
      setImportJob(j => ({ ...j, status: 'failed', current_item: e.message }))
    } finally {
      clearInterval(poll); clearInterval(anim)
      setDisplayProgress(done ? 100 : 0); setRpm(0)
      setSyncingAll(false)
    }
  }

  // Skips listing import — just sold orders → fees → reconcile. Fast (~30s).
  const quickSync = async () => {
    setSyncingAll(true)
    setImportJob({ status: 'running', current_item: 'Importing sold orders…', total_items: 100, imported: 0, skipped: 0, failed: 0 })
    setDisplayProgress(5)
    setRpm(60)
    try {
      setSyncPhase('1/3 · Importing sold orders…')
      const so = await runSoldOrders(120)
      setDisplayProgress(33)
      setRpm(80)
      const soFail = so.failed > 0 ? ` · ${so.failed} failed${so.failedReasons?.length ? ': ' + so.failedReasons[0] : ''}` : ''
      const soMsg = `Sold orders: ${so.created ?? 0} new, ${so.updated ?? 0} updated${soFail}`
      setSyncPhase(`1/3 · ${soMsg}`)
      setImportJob(j => ({ ...j, current_item: 'Importing eBay fees…' }))
      setSyncPhase('2/3 · Importing eBay fees…')
      setDisplayProgress(50)
      const f = await runFeesSafe(120)
      setDisplayProgress(66)
      setRpm(70)
      const fMsg = f.feesFailed ? `Fees skipped (${f.feeError}) — continuing` : `Fees: $${(f.feeTotal ?? 0).toFixed(2)} across ${f.ordersMatched ?? 0} orders`
      setSyncPhase(`2/3 · ${fMsg}`)
      setImportJob(j => ({ ...j, current_item: 'Reconciling with eBay…' }))
      setSyncPhase('3/3 · Reconciling with eBay…')
      setDisplayProgress(80)
      setRpm(50)
      const rec = await runReconcile()
      setDisplayProgress(100)
      setRpm(0)
      setImportJob(j => ({ ...j, status: 'completed', current_item: `✓ ${soMsg} · ${fMsg}` }))
      setSyncPhase('✓ Quick sync complete')
      await logSync(
        `Quick sync ✓ · ${so.created ?? 0} sold new/${so.updated ?? 0} updated · $${f.feeTotal ?? 0} fees`,
        { soldNew: so.created ?? 0, soldUpdated: so.updated ?? 0, feeTotal: f.feeTotal ?? 0, missing: rec?.missingCount ?? 0, stale: rec?.staleCount ?? 0 },
      )
    } catch (e) {
      setSyncPhase(`Sync stopped: ${e.message}`)
      setImportJob(j => ({ ...j, status: 'failed', current_item: e.message }))
      await logSync(`Quick sync failed: ${e.message}`, { ok: false })
    }
    setSyncingAll(false)
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
          const { data: { session } } = await sb.auth.getSession()
          const res = await fetch('https://mtpektsxaklhedknincs.supabase.co/functions/v1/ai-assess', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ storeId, mode: 'parse-title', title: part.title }),
          })
          const d = await res.json()
          if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`)
          const parsed = d.result || {}
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
    { id: 'shipping', label: '📦 Shipping' },
    { id: 'warehouse', label: '🗺️ Warehouse' },
    { id: 'team', label: '👥 User Access' },
    { id: 'activity', label: '📋 Activity' },
  ]

  const importProgress = importJob ? (() => {
    const total = importJob.total_items || 0
    const done = (importJob.imported || 0) + (importJob.skipped || 0) + (importJob.failed || 0)
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  })() : 0

  // Smooth display progress: trickles forward between real updates so the bar
  // always moves. Resets to 0 on each new job, snaps forward on real updates.
  const [displayProgress, setDisplayProgress] = useState(0)
  const lastJobId = useRef(null)
  useEffect(() => {
    if (!importJob) { setDisplayProgress(0); lastJobId.current = null; return }
    // Reset to 0 whenever a brand-new job starts
    if (importJob.id && importJob.id !== lastJobId.current) {
      lastJobId.current = importJob.id
      setDisplayProgress(0)
    }
    if (importJob.status === 'completed') { setDisplayProgress(100); return }
    // Snap forward if real progress jumped ahead
    setDisplayProgress(p => p < importProgress ? importProgress : p)
    // Trickle toward a ceiling just ahead of real progress
    const ceiling = Math.min(importProgress + 2, 99)
    const id = setInterval(() => {
      setDisplayProgress(p => p >= ceiling ? p : Math.min(p + 0.4, ceiling))
    }, 300)
    return () => clearInterval(id)
  }, [importProgress, importJob?.status, importJob?.id])

  // Tachometer RPM — spikes when chunks process fast, decays slowly to idle floor
  const [rpm, setRpm] = useState(0)
  const rpmTrackRef = useRef({ time: Date.now(), progress: 0 })
  const rpmOscRef = useRef(0)
  useEffect(() => {
    if (!importJob || importJob.status === 'completed') { setRpm(0); return }
    const now = Date.now()
    const dt = (now - rpmTrackRef.current.time) / 1000
    const delta = importProgress - rpmTrackRef.current.progress
    rpmTrackRef.current = { time: now, progress: importProgress }
    if (delta > 0 && dt > 0) setRpm(prev => Math.min(100, Math.max(prev, (delta / dt) * 15)))
    // Decay slowly to a breathing idle floor — never drops to zero while active
    const decay = setInterval(() => {
      rpmOscRef.current += 0.12
      const idleFloor = 18 + Math.sin(rpmOscRef.current) * 6
      setRpm(r => Math.max(idleFloor, r - 0.7))
    }, 200)
    return () => clearInterval(decay)
  }, [importProgress, importJob?.id, importJob?.status])

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
        {(tab === 'descriptions' || tab === 'warehouse') && (
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

      {/* SHIPPING TAB */}
      {tab === 'shipping' && <ShippingSettings storeId={storeId} />}

      {/* WAREHOUSE TAB — physical storage: rent-based storage cost + the optional Row/Bay/Shelf grid */}
      {tab === 'warehouse' && !loading && (
        <>
          <Section title="🏠 Storage facility">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Turns your warehouse rent into a per-part storage cost. Rent is spread over the volume you can actually use
              for sellable stock (the rest — working space, intake, air — is paid for too, so the stock carries it). A part's
              volume comes from its category box size (set under Shipping), and the cost accrues over how long it's held, so
              slow movers cost more. Feeds into part cost, margins and the Vehicle scores.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <div style={{ flex: '1 1 150px' }}>
                <label style={S.label}>Total warehouse volume (m³)</label>
                <input type="number" style={S.input} value={storage.volumeM3} onChange={e => setStorage(s => ({ ...s, volumeM3: e.target.value }))} placeholder="e.g. 600" />
              </div>
              <div style={{ flex: '1 1 150px' }}>
                <label style={S.label}>Rent ($)</label>
                <input type="number" style={S.input} value={storage.rent} onChange={e => setStorage(s => ({ ...s, rent: e.target.value }))} placeholder="e.g. 3000" />
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <label style={S.label}>Rent period</label>
                <select style={S.select} value={storage.rentPeriod} onChange={e => setStorage(s => ({ ...s, rentPeriod: e.target.value }))}>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </select>
              </div>
              <div style={{ flex: '1 1 150px' }}>
                <label style={S.label}>Usable for storage (%)</label>
                <input type="number" style={S.input} value={storage.usablePct} onChange={e => setStorage(s => ({ ...s, usablePct: e.target.value }))} />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Default 25% (15% working · 10% intake · 50% air).</div>
              </div>
            </div>
            {(() => {
              const vol = +storage.volumeM3 || 0, pct = +storage.usablePct || 0
              const perDay = rentPerDay(storage.rent, storage.rentPeriod)
              const usable = vol * pct / 100
              if (!(vol > 0 && perDay > 0 && usable > 0)) return (
                <div style={{ fontSize: 12, color: C.muted }}>Enter volume, rent and usable % to see the storage rate.</div>
              )
              const ratePerM3Yr = (perDay / usable) * 365
              return (
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
                  Usable storage volume: <strong>{usable.toFixed(1)} m³</strong> · Storage rate:
                  <strong> ${ratePerM3Yr.toFixed(0)}/m³ per year</strong> (${(ratePerM3Yr / 365).toFixed(3)}/m³/day).
                  A part in a 40×30×20 cm box (0.024 m³) held 6 months ≈ <strong>${(ratePerM3Yr * 0.024 / 2).toFixed(2)}</strong>.
                </div>
              )
            })()}
          </Section>

          <Section title="🗺️ Warehouse map">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Optional. Describe your shelving as a grid so each part can be tagged with a <strong>{warehouse.rowLabel}/{warehouse.bayLabel}/{warehouse.shelfLabel}</strong> position.
              The mobile Collect pick-list then draws a little map that points a picker straight to the spot — no more hunting by photo.
              Leave it off if you don't want structured locations (the free-text location field still works).
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, cursor: 'pointer', marginBottom: 14, fontWeight: 600 }}>
              <input type="checkbox" checked={!!warehouse.enabled} onChange={e => updateWarehouse(w => ({ ...w, enabled: e.target.checked }))} />
              Use a warehouse grid
            </label>
            {warehouse.enabled && (() => {
              const clampN = v => { const n = Math.round(+v || 0); return n < 0 ? 0 : (n > 40 ? 40 : n) }
              return (
                <>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={S.label}>Rows / aisles (how many wide)</label>
                      <input type="number" min="0" max="40" style={S.input} value={warehouse.rows} onChange={e => updateWarehouse(w => ({ ...w, rows: clampN(e.target.value) }))} placeholder="e.g. 6" />
                    </div>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={S.label}>Bays per row (length)</label>
                      <input type="number" min="0" max="40" style={S.input} value={warehouse.bays} onChange={e => updateWarehouse(w => ({ ...w, bays: clampN(e.target.value) }))} placeholder="e.g. 10" />
                    </div>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={S.label}>Shelves per bay (levels)</label>
                      <input type="number" min="0" max="40" style={S.input} value={warehouse.shelves} onChange={e => updateWarehouse(w => ({ ...w, shelves: clampN(e.target.value) }))} placeholder="e.g. 4" />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={S.label}>Name for a row</label>
                      <input style={S.input} value={warehouse.rowLabel} onChange={e => updateWarehouse(w => ({ ...w, rowLabel: e.target.value || 'Row' }))} placeholder="Row" />
                    </div>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={S.label}>Name for a bay</label>
                      <input style={S.input} value={warehouse.bayLabel} onChange={e => updateWarehouse(w => ({ ...w, bayLabel: e.target.value || 'Bay' }))} placeholder="Bay" />
                    </div>
                    <div style={{ flex: '1 1 120px' }}>
                      <label style={S.label}>Name for a shelf</label>
                      <input style={S.input} value={warehouse.shelfLabel} onChange={e => updateWarehouse(w => ({ ...w, shelfLabel: e.target.value || 'Shelf' }))} placeholder="Shelf" />
                    </div>
                  </div>
                  {warehouse.rows > 0 && warehouse.bays > 0 ? (
                    <div>
                      <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Floor plan preview ({warehouse.rows} {warehouse.rows === 1 ? 'row' : 'rows'} × {warehouse.bays} {warehouse.bays === 1 ? 'bay' : 'bays'}, {warehouse.shelves || 0} {warehouse.shelves === 1 ? 'shelf' : 'shelves'} deep):</div>
                      <WarehouseMap warehouse={warehouse} part={{ locRow: 1, locBay: 1, locShelf: warehouse.shelves ? 1 : null }} />
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: C.muted }}>Enter rows and bays to see the floor plan.</div>
                  )}
                </>
              )
            })()}
          </Section>

          <Section title="🪣 Containers (tubs & buckets)">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              For stock kept in movable tubs, buckets or bins rather than a fixed shelf. Each container gets a printable QR —
              scan it from the phone, then scan parts <strong>in</strong> (putting away) or <strong>out</strong> (pulling). A
              container can be parked at a grid spot so parts inside inherit that location, or just float and be found by scanning.
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: C.text, cursor: 'pointer', fontWeight: 600 }}>
                <input type="checkbox" checked={!!warehouse.containers} onChange={e => updateWarehouse(w => ({ ...w, containers: e.target.checked }))} />
                Use containers
              </label>
              {warehouse.containers && (
                <div style={{ flex: '0 1 200px' }}>
                  <label style={S.label}>What you call one</label>
                  <input style={S.input} value={warehouse.containerLabel} onChange={e => updateWarehouse(w => ({ ...w, containerLabel: e.target.value || 'Bucket' }))} placeholder="Bucket / Tub / Bin" />
                </div>
              )}
            </div>
            {warehouse.containers && (
              <ContainerManager storeId={storeId} warehouse={warehouse} labels={labels} />
            )}
          </Section>
        </>
      )}

      {/* USER ACCESS TAB */}
      {tab === 'team' && <TeamAccess storeId={storeId} />}

      {/* ACTIVITY TAB */}
      {tab === 'activity' && <Activity storeId={storeId} />}

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

          {/* Store-level config (moved from the eBay tab): plan, name, marketplace, timezone */}
              {/* Subscription plan + AI usage this month */}
              <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>💳 Plan</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: C.accent }}>
                    {plan.founder ? 'Founder (all features)' : plan.label}
                    {plan.tier === 'trial' && !plan.expired && ` — ${Math.max(plan.trialDaysLeft ?? 0, 0)} days left`}
                    {plan.expired && ' — expired'}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                  {aiUsage
                    ? `AI this month: ${aiUsage.full_count} full assessment${aiUsage.full_count === 1 ? '' : 's'}${plan.founder ? '' : ` of ${plan.limits.aiFull}`} · ${aiUsage.light_count} quick calls (naming etc, uncapped).`
                    : 'Loading AI usage…'}
                  {' '}Full assessments (photos → title, description, price, specifics) are the metered unit; quick naming is free.
                </div>
                {plan.founder && (
                  <div style={{ marginTop: 8 }}>
                    <button style={{ ...S.btn('secondary'), padding: '4px 10px', fontSize: 11 }} onClick={() => setPreviewCustomer(p => !p)}>
                      {previewCustomer ? '✓ Previewing customer view — exit' : '👁 Preview customer billing view'}
                    </button>
                  </div>
                )}
                {showBilling && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: C.text }}>
                      🎟️ AI credits: <b>{aiCredits == null ? '…' : aiCredits}</b>
                      <span style={{ color: C.muted }}> — used automatically once your monthly allowance runs out.</span>
                    </span>
                    <button disabled={billingBusy} style={{ ...S.btn('secondary'), padding: '5px 12px', fontSize: 12 }}
                      onClick={() => buy(() => startCheckout({ storeId, pack: 'credits_300' }))}>
                      Buy AI credits
                    </button>
                  </div>
                )}
                {showBilling && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                    <button disabled={billingBusy} style={{ ...S.btn('primary'), padding: '6px 14px', fontSize: 12 }} onClick={() => setShowPlans(s => !s)}>
                      {plan.tier === 'trial' || plan.expired ? 'Choose a plan' : 'Change plan'}
                    </button>
                    {plan.tier !== 'trial' && (
                      <button disabled={billingBusy} style={{ ...S.btn('secondary'), padding: '6px 14px', fontSize: 12 }} onClick={() => buy(() => openBillingPortal(storeId))}>
                        Manage billing
                      </button>
                    )}
                  </div>
                )}
                {showPlans && showBilling && (
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                    {PLAN_CADENCES.map(cad => (
                      <div key={cad.id} style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{cad.label}</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {['basic', 'pro', 'business'].map(tier => (
                            <button key={tier} disabled={billingBusy}
                              style={{ ...S.btn('secondary'), padding: '6px 12px', fontSize: 12, textTransform: 'capitalize' }}
                              onClick={() => buy(() => startCheckout({ storeId, tier, cadence: cad.id }))}>
                              {tier} {cad.price[tier]}{cad.suffix}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 11, color: C.muted }}>12-month plans commit to the full 12 months. Upfront adds 2 free months. You'll be taken to secure Stripe checkout.</div>
                  </div>
                )}
              </div>

              {/* Store name — editable by an admin/owner. */}
              <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                <label style={S.label}>🏪 Store name</label>
                <div style={{ display: 'flex', gap: 8, maxWidth: 460 }}>
                  <input style={{ ...S.input, flex: 1 }} value={storeName} onChange={e => setStoreName(e.target.value)} placeholder="Store name" />
                  <button style={S.btn('secondary')} disabled={!storeName.trim()}
                    onClick={async () => {
                      const { error } = await sb.from('stores').update({ name: storeName.trim() }).eq('id', storeId)
                      if (error) { setNameMsg(`✗ ${error.message}`); return }
                      setNameMsg('Saved ✓'); setTimeout(() => setNameMsg(''), 2000); refreshStores?.()
                    }}>Save</button>
                  {nameMsg && <span style={{ fontSize: 12, color: nameMsg.startsWith('✗') ? C.red : C.green, fontWeight: 600, alignSelf: 'center' }}>{nameMsg}</span>}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Shown in the store switcher and on labels. This is the join code for workers: <b>{joinCode || '—'}</b> (random, keeps the store secure).</div>
              </div>

              {/* Marketplace (country) — chosen at store creation, locked at first part */}
              <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>🌏 Marketplace</span>
                  {mpLocked ? (
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                      {MARKETPLACES[marketplace]?.flag} {MARKETPLACES[marketplace]?.label || marketplace} — eBay ({MARKETPLACES[marketplace]?.currency})
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: C.muted, background: '#eee', borderRadius: 10, padding: '2px 8px' }}>🔒 locked</span>
                    </span>
                  ) : (
                    <select value={marketplace} onChange={e => saveMarketplace(e.target.value)}
                      style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, background: '#fff' }}>
                      {MARKETPLACE_LIST.map(m => <option key={m.id} value={m.id}>{m.flag} {m.label} — eBay ({m.currency})</option>)}
                    </select>
                  )}
                  {mpSaved && <span style={{ fontSize: 12, color: C.green }}>✓ saved</span>}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                  {mpLocked
                    ? 'Locked because this store has parts — their prices and categories are committed to this country. Selling in another country? Create a new store for it.'
                    : 'Which eBay site this store lists on (sets currency and categories). Locks permanently once the first part is created.'}
                </div>
              </div>

              {/* Store timezone — drives nightly sync timing + default sales window */}
              <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>🕓 Store timezone</span>
                  <select value={timezone} onChange={e => saveTimezone(e.target.value)}
                    style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, background: '#fff', maxWidth: 240 }}>
                    {!tzList.includes(timezone) && <option value={timezone}>{timezone}</option>}
                    {tzList.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                  {tzSaved && <span style={{ fontSize: 12, color: C.green }}>✓ saved</span>}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                  {(() => {
                    let local = ''
                    try { local = new Date().toLocaleString('en-AU', { timeZone: timezone, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) } catch { /* invalid tz */ }
                    return `Sync windows are anchored to midnight here${local ? ` · local time now ${local}` : ''}. Auto-detected from your browser — edit if it's wrong (e.g. on a VPN). Auto-sync frequency is set under eBay Sync.`
                  })()}
                </div>
              </div>


          <Section title="AI">
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
              AI assessment and title parsing are provided by PartVault — there's no key to configure. Requests run server-side so your credentials are never exposed in the browser.
            </div>
          </Section>
          <Section title="SKU Format">
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
              The template used to auto-generate SKUs for new parts. The running number is store-wide and never reused. Tokens for a part with no linked car simply render empty.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap', marginBottom: 12 }}>
              <input
                value={skuTemplate}
                onChange={e => setSkuTemplate(e.target.value)}
                placeholder={DEFAULT_SKU_TEMPLATE}
                style={{ ...S.input, flex: '1 1 320px', minWidth: 0, fontFamily: 'monospace', fontSize: 13 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ fontSize: 12, color: C.muted }}>Pad</label>
                <input
                  type="number" min={1} max={8} value={skuPad}
                  onChange={e => setSkuPad(e.target.value)}
                  style={{ ...S.input, width: 64, fontSize: 13 }}
                />
              </div>
              <button
                onClick={saveSkuFormat}
                disabled={skuSaving}
                style={{ ...S.btn(skuSaved ? 'success' : 'primary'), padding: '0 20px', whiteSpace: 'nowrap' }}
              >
                {skuSaving ? 'Saving…' : skuSaved ? '✓ Saved' : 'Save'}
              </button>
            </div>
            <div style={{ fontSize: 13, marginBottom: 12 }}>
              <span style={{ color: C.muted }}>Preview: </span>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: C.text, background: '#f4f4f5', borderRadius: 6, padding: '3px 8px' }}>
                {buildSkuPreview(skuTemplate, skuPad)}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SKU_TOKENS.map(([tok, desc]) => (
                <button key={tok} type="button" onClick={() => setSkuTemplate(t => t + tok)}
                  title={desc}
                  style={{ fontFamily: 'monospace', fontSize: 12, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: C.text }}>
                  {tok}
                </button>
              ))}
            </div>
          </Section>
          <Section title="Marketing Images">
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
              Standard images added to the end of every eBay listing (e.g. store info, warranty, shipping). They're appended after the part and car photos, up to eBay's 24-image limit.
            </div>
            <input ref={mktFileRef} type="file" accept="image/*" multiple onChange={uploadMarketing} style={{ display: 'none' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {marketingImages.map(url => (
                <div key={url} style={{ position: 'relative', width: 90, height: 90, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}` }}>
                  <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <button onClick={() => removeMarketing(url)} style={{ position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: '50%', width: 22, height: 22, fontSize: 13, cursor: 'pointer', padding: 0, lineHeight: '22px' }}>×</button>
                </div>
              ))}
              <button onClick={() => mktFileRef.current?.click()} disabled={mktUploading}
                style={{ width: 90, height: 90, borderRadius: 8, border: `2px dashed ${C.border}`, background: '#fafaf9', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 12, color: C.muted, fontWeight: 600 }}>
                <span style={{ fontSize: 22 }}>{mktUploading ? '⏳' : '＋'}</span>{mktUploading ? '' : 'Add'}
              </button>
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
          <Section title="📱 Mobile capture AI">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              What the AI fills in automatically when a part is captured on the phone. The part name is always pre-filled. Everything else (description, item specifics, fitment) is done here in admin.
            </p>
            <Toggle label="Assess category at capture" desc="Auto-pick the part category from the photo." value={captureAssess.category} onChange={v => setCaptureAssess(s => ({ ...s, category: v }))} />
            <Toggle label="Suggest a sale price at capture" desc="Fill a suggested list price (only when none was entered)." value={captureAssess.price} onChange={v => setCaptureAssess(s => ({ ...s, price: v }))} />
          </Section>

          <Section title="🧠 AI model">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 1.6 }}>
              Which model does the full part assessment. Higher quality costs more AI credits per part.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[
                { id: 'economy',  name: 'Economy',  weight: 1, blurb: 'Fast, lowest cost. Good for simple/common parts.' },
                { id: 'standard', name: 'Standard',  weight: 2, blurb: 'Balanced quality — recommended for most listings.' },
                { id: 'premium',  name: 'Premium',  weight: 4, blurb: 'Deepest reasoning + more photos. Best detail.' },
              ].map(t => (
                <button key={t.id} onClick={() => saveAiModel(t.id)}
                  style={{ flex: '1 1 200px', textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '12px 14px',
                    border: `2px solid ${aiModel === t.id ? C.accent : C.border}`, background: aiModel === t.id ? C.accent + '12' : '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{t.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, background: C.accent + '18', borderRadius: 6, padding: '2px 7px' }}>{t.weight} credit{t.weight === 1 ? '' : 's'}/part</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 5, lineHeight: 1.5 }}>{t.blurb}</div>
                </button>
              ))}
            </div>
            {amSaved && <div style={{ fontSize: 12, color: C.green, marginTop: 8 }}>✓ saved</div>}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>Credits come from your monthly plan allowance, then top-up packs. Premium uses your allowance ~4× faster than Economy.</div>
          </Section>

          <Section title="💰 Costing">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Used to estimate each part's cost basis: the car's purchase price spread across its parts (by sale price), plus removal labour (AI-estimated minutes × your rate), plus an admin cost.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 160px' }}>
                <label style={{ ...S.label, display: 'flex', alignItems: 'center' }}>
                  {(costing.labourMode === 'percent') ? 'Labour (% of sale)' : 'Labour rate ($/hour)'}
                  <ModeToggle mode={costing.labourMode || 'fixed'} onChange={m => setCosting(s => ({ ...s, labourMode: m }))} opts={[['fixed', '$/hr'], ['percent', '%']]} />
                </label>
                <input type="number" style={S.input} value={costing.labourRate} onChange={e => setCosting(s => ({ ...s, labourRate: e.target.value }))} />
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label style={{ ...S.label, display: 'flex', alignItems: 'center' }}>
                  {(costing.adminMode === 'fixed') ? 'Admin cost ($/part)' : 'Admin cost (% of sale)'}
                  <ModeToggle mode={costing.adminMode || 'percent'} onChange={m => setCosting(s => ({ ...s, adminMode: m }))} opts={[['percent', '%'], ['fixed', '$']]} />
                </label>
                <input type="number" style={S.input} value={costing.adminPct} onChange={e => setCosting(s => ({ ...s, adminPct: e.target.value }))} />
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label style={{ ...S.label, display: 'flex', alignItems: 'center' }}>
                  {(costing.adminMinMode === 'percent') ? 'Admin minimum (% of sale)' : 'Admin minimum ($)'}
                  <ModeToggle mode={costing.adminMinMode || 'fixed'} onChange={m => setCosting(s => ({ ...s, adminMinMode: m }))} opts={[['fixed', '$'], ['percent', '%']]} />
                </label>
                <input type="number" style={S.input} value={costing.adminMin} onChange={e => setCosting(s => ({ ...s, adminMin: e.target.value }))} />
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
              Admin cost per part = the greater of {costing.adminPct || 0}{(costing.adminMode === 'fixed') ? ' $' : '% of sale'} or {costing.adminMin || 0}{(costing.adminMinMode === 'percent') ? '% of sale' : ' $'}.
              {(costing.labourMode === 'percent') && ' Labour is a flat % of sale (ignores removal minutes).'}
            </div>

            <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>🧱 Base cost (fallback)</div>
              <p style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 1.6 }}>
                When a part has <em>no</em> cost data at all — not linked to a car and no costs entered — we assume a base part cost (a % of its sale price or a fixed $), plus the estimated delivery cost below. This gives businesses with no cost history a realistic starting cost base (and stops the Dashboard showing fake 100% margins). The moment you link a car or enter any real cost, that wins over this fallback.
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 160px' }}>
                  <label style={{ ...S.label, display: 'flex', alignItems: 'center' }}>
                    {(costing.baseCostMode === 'fixed') ? 'Base cost ($/part)' : 'Base cost (% of sale)'}
                    <ModeToggle mode={costing.baseCostMode || 'percent'} onChange={m => setCosting(s => ({ ...s, baseCostMode: m }))} opts={[['percent', '%'], ['fixed', '$']]} />
                  </label>
                  <input type="number" style={S.input} value={costing.baseCostPct} onChange={e => setCosting(s => ({ ...s, baseCostPct: e.target.value }))} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Set 0 to disable the fallback.</div>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>📦 Postage & handling cost</div>
              <p style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 1.6 }}>
                eBay tells us what the buyer <em>paid</em> for shipping, but never what it <em>cost</em> you to post. When a sale has no recorded carrier cost (e.g. free-shipping listings), we estimate it from the part's weight using this rate table, plus a fixed handling charge. Any actual postage you record on a part always wins over the estimate.
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ flex: '1 1 140px' }}>
                  <label style={S.label}>Handling fee ($/parcel)</label>
                  <input type="number" style={S.input} value={costing.handlingFee} onChange={e => setCosting(s => ({ ...s, handlingFee: e.target.value }))} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Packing time + materials per order.</div>
                </div>
                <div style={{ flex: '1 1 140px' }}>
                  <label style={S.label}>Assumed weight if blank (g)</label>
                  <input type="number" style={S.input} value={costing.postageDefaultG} onChange={e => setCosting(s => ({ ...s, postageDefaultG: e.target.value }))} />
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Used when a part has no weight.</div>
                </div>
              </div>
              <label style={S.label}>Carrier rate table (by parcel weight)</label>
              <div style={{ marginTop: 6 }}>
                {(costing.postageTiers || []).map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: C.muted, width: 56 }}>up to</span>
                    <input type="number" style={{ ...S.input, width: 110 }} value={t.maxG}
                      onChange={e => setCosting(s => ({ ...s, postageTiers: s.postageTiers.map((x, j) => j === i ? { ...x, maxG: e.target.value } : x) }))} />
                    <span style={{ fontSize: 12, color: C.muted }}>g  →  $</span>
                    <input type="number" step="0.01" style={{ ...S.input, width: 100 }} value={t.cost}
                      onChange={e => setCosting(s => ({ ...s, postageTiers: s.postageTiers.map((x, j) => j === i ? { ...x, cost: e.target.value } : x) }))} />
                    <button type="button" style={{ ...S.btn('danger'), padding: '6px 12px' }}
                      onClick={() => setCosting(s => ({ ...s, postageTiers: s.postageTiers.filter((_, j) => j !== i) }))}>Delete row</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button type="button" style={{ ...S.btn('secondary'), padding: '6px 12px' }}
                    onClick={() => setCosting(s => ({ ...s, postageTiers: [...(s.postageTiers || []), { maxG: 0, cost: 0 }] }))}>+ Add tier</button>
                  <button type="button" style={{ ...S.btn('secondary'), padding: '6px 12px' }}
                    onClick={() => setCosting(s => ({ ...s, postageTiers: defaultPostageTiers() }))}>Reset to defaults</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 12 }}>The heaviest tier is used for anything over the top weight. Estimated postage = matching carrier rate + handling fee.</div>
            </div>
          </Section>

          <Section title="🏷️ Stock labels">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Printable shelf labels with a scannable QR (links to the part) plus SKU and details. Set the size to match your
              printer — a thermal label roll (one label per print) or an A4 sheet of labels. Print from any part (🏷️ button in
              the editor or inventory list).
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <div style={{ flex: '1 1 120px' }}>
                <label style={S.label}>Print mode</label>
                <select style={S.select} value={labels.mode} onChange={e => setLabels(s => ({ ...s, mode: e.target.value }))}>
                  <option value="roll">Label roll (thermal)</option>
                  <option value="sheet">A4 sheet</option>
                </select>
              </div>
              <div style={{ flex: '1 1 100px' }}>
                <label style={S.label}>Width (mm)</label>
                <input type="number" style={S.input} value={labels.widthMm} onChange={e => setLabels(s => ({ ...s, widthMm: e.target.value }))} />
              </div>
              <div style={{ flex: '1 1 100px' }}>
                <label style={S.label}>Height (mm)</label>
                <input type="number" style={S.input} value={labels.heightMm} onChange={e => setLabels(s => ({ ...s, heightMm: e.target.value }))} />
              </div>
              {labels.mode === 'sheet' && (
                <div style={{ flex: '1 1 100px' }}>
                  <label style={S.label}>Columns / row</label>
                  <input type="number" style={S.input} value={labels.sheetCols} onChange={e => setLabels(s => ({ ...s, sheetCols: e.target.value }))} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              {[['showQR', 'QR code'], ['showSku', 'SKU'], ['showTitle', 'Title'], ['showFitment', 'Make/Model/Year'], ['showPrice', 'Price']].map(([k, lbl]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.text, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!labels[k]} onChange={e => setLabels(s => ({ ...s, [k]: e.target.checked }))} />
                  {lbl}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
              <div style={{ flex: '1 1 280px' }}>
                <label style={S.label}>QR link base (the PWA resolves /p/&lt;sku&gt;)</label>
                <input style={S.input} value={labels.qrBaseUrl} onChange={e => setLabels(s => ({ ...s, qrBaseUrl: e.target.value }))} placeholder="https://app.partvault.app" />
              </div>
              <button style={{ ...S.btn('secondary') }} onClick={() => printLabels({ id: 'TEST', sku: 'SAMPLE-001', title: 'Sample part — Toyota Hilux Headlight', make: 'Toyota', model: 'Hilux', year: '2015-2020', listPrice: 120 }, labels)}>🏷️ Print test label</button>
            </div>
            <div style={{ flex: '1 1 240px' }}>
              <label style={S.label}>Mobile capture — when you finish a part</label>
              <select style={S.select} value={labels.onDone || 'ask'} onChange={e => setLabels(s => ({ ...s, onDone: e.target.value }))}>
                <option value="ask">Ask whether to print a label</option>
                <option value="always">Always print a label</option>
                <option value="never">Don't print</option>
              </select>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>The field app prints a stock label on "Done" per this setting (its "don't ask again" toggle maps here).</div>
            </div>
          </Section>

          <Section title="📦 Aged stock">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Controls the Dashboard aged-stock report: when stock counts as "aged", and the age brackets the chart groups unsold stock into.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
              <div style={{ flex: '1 1 160px' }}>
                <label style={S.label}>Aged after (days)</label>
                <input type="number" style={S.input} value={inventory.agedThresholdDays} onChange={e => setInventory(s => ({ ...s, agedThresholdDays: e.target.value }))} />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Stock unsold longer than this is flagged aged.</div>
              </div>
            </div>
            <label style={S.label}>Age brackets (days, ascending)</label>
            <div style={{ marginTop: 6 }}>
              {(inventory.ageBrackets || []).map((b, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: C.muted, width: 56 }}>up to</span>
                  <input type="number" style={{ ...S.input, width: 120 }} value={b}
                    onChange={e => setInventory(s => ({ ...s, ageBrackets: s.ageBrackets.map((x, j) => j === i ? e.target.value : x) }))} />
                  <span style={{ fontSize: 12, color: C.muted }}>days</span>
                  <button type="button" style={{ ...S.btn('danger'), padding: '6px 12px' }}
                    onClick={() => setInventory(s => ({ ...s, ageBrackets: s.ageBrackets.filter((_, j) => j !== i) }))}>Delete row</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button type="button" style={{ ...S.btn('secondary'), padding: '6px 12px' }}
                  onClick={() => setInventory(s => ({ ...s, ageBrackets: [...(s.ageBrackets || []), 0].map(Number).sort((a, b) => a - b) }))}>+ Add bracket</button>
                <button type="button" style={{ ...S.btn('secondary'), padding: '6px 12px' }}
                  onClick={() => setInventory(s => ({ ...s, ageBrackets: DEFAULT_AGE_BRACKETS }))}>Reset to defaults</button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 12 }}>Anything older than the last bracket falls into an "older" group. Defaults: 90 · 180 · 365 · 730 · 1065 days.</div>
          </Section>

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

          <Section title="🏷️ Listing Defaults">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Applied to every eBay listing when you publish, unless a part overrides them.
            </p>
            <div style={{ marginBottom: 18 }}>
              <label style={S.label}>Warranty period</label>
              <input list="warranty-options" style={S.input} placeholder="1 Month (default if left blank)"
                value={listingDefaults.warranty}
                onChange={e => setListingDefaults(d => ({ ...d, warranty: e.target.value }))} />
              <datalist id="warranty-options">
                <option value="1 Month" />
                <option value="3 Months" />
                <option value="6 Months" />
                <option value="1 Year" />
                <option value="No Warranty" />
              </datalist>
              <p style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                Fills eBay's <strong>Warranty</strong> item specific (a time period, e.g. “1 Month”). Leave blank to default to <strong>1 Month</strong>.
              </p>
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={S.label}>Default condition description</label>
              <textarea style={{ ...S.textarea, minHeight: 90, fontSize: 13, lineHeight: 1.6 }}
                placeholder="e.g. In good used condition, removed from a low-kilometre vehicle. Fully tested and functional. See photos for exact item."
                value={listingDefaults.conditionDescription}
                onChange={e => setListingDefaults(d => ({ ...d, conditionDescription: e.target.value }))}
                maxLength={1000} />
              <p style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                Shown in eBay's <strong>Condition</strong> box below the photos. Keep it honest but positive — you're selling. {listingDefaults.conditionDescription.length}/1000
              </p>
            </div>
            <div style={{ fontSize: 12, color: C.muted, padding: '8px 10px', background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <strong>Listing duration:</strong> Good 'Til Cancelled (GTC) — eBay's only option for fixed-price listings, so every listing renews automatically until sold or ended.
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

      {/* EBAY SYNC TAB — Sync gets the wide main area; connection + address sit in
          a compact left sidebar so it all fits without wasting the left half. */}
      {tab === 'ebay' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 340px) 1fr', gap: 16, alignItems: 'start' }}>
          <div>
          {/* Connection */}
          <Section title="🔗 eBay Connection">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: 16, background: ebayNeedsReconnect ? '#fffbeb' : ebayConnected ? '#f0fdf4' : '#fafaf9', border: `1px solid ${ebayNeedsReconnect ? '#fcd34d' : ebayConnected ? '#86efac' : C.border}`, borderRadius: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: ebayNeedsReconnect ? C.yellow : ebayConnected ? C.green : C.muted, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: ebayNeedsReconnect ? C.yellow : ebayConnected ? C.green : C.muted }}>
                  {ebayNeedsReconnect ? 'eBay session expired' : ebayConnected ? 'Connected to eBay' : 'Not connected'}
                </div>
                {ebayConnected && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                    {ebayUsername ? (
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.text, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 8px' }}>
                        👤 {ebayUsername}
                      </span>
                    ) : ebayUsernameStatus === 'loading' ? (
                      <span style={{ fontSize: 12, color: C.muted }}>Checking account…</span>
                    ) : ebayNeedsReconnect ? (
                      <span style={{ fontSize: 12, color: C.yellow }}>Account hidden until you reconnect</span>
                    ) : (
                      <span style={{ fontSize: 12, color: C.red }}>Account unknown — tap Refresh</span>
                    )}
                    <button onClick={refreshEbayUsername} disabled={ebayUsernameStatus === 'loading'}
                      style={{ background: 'none', border: 'none', color: C.blue, cursor: 'pointer', fontSize: 12, padding: 0, opacity: ebayUsernameStatus === 'loading' ? 0.5 : 1 }}>
                      ⟳ {ebayUsernameStatus === 'loading' ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>
                )}
                {ebayConnected && ebayUsernameStatus === 'error' && ebayUsernameError && !ebayNeedsReconnect && (
                  <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{ebayUsernameError}</div>
                )}
                {ebayConnected && ebayExpiry && (
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                    Expires: {new Date(ebayExpiry).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                )}
              </div>
            </div>

            {ebayConnected && ebayNeedsReconnect && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, marginBottom: 12, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8 }}>
                <div style={{ fontSize: 20, flexShrink: 0 }}>⚠️</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{ebayUsernameError || 'Your eBay session has expired.'}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Importing and listing are paused until you reconnect. You'll choose which eBay account to connect.</div>
                </div>
                <button style={{ ...S.btn('primary'), flexShrink: 0 }} onClick={connectEbay}>
                  Reconnect
                </button>
              </div>
            )}

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

          <Section title="📍 eBay Inventory Location">
            <p style={{ fontSize: 12, color: C.muted, marginBottom: 10, lineHeight: 1.45 }}>
              eBay's required item location. One-time — Save once.
              {ebayLocationKey && <span style={{ color: C.green }}> · ✓ active</span>}
            </p>
            {/* Compact: address on one row, city/state/postcode on the next, with
                small always-visible labels (placeholders vanish once filled). */}
            {(() => {
              const mini = { fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 3 }
              // Normalise full AU state names to the standard abbreviations.
              const AU_STATES = { queensland: 'QLD', 'new south wales': 'NSW', victoria: 'VIC', tasmania: 'TAS', 'south australia': 'SA', 'western australia': 'WA', 'northern territory': 'NT', 'australian capital territory': 'ACT' }
              const abbrevState = v => AU_STATES[String(v || '').trim().toLowerCase()] || v
              return (
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={mini}>Address</label>
                    <input style={S.input} value={shipAddress.addressLine1} onChange={e => setShipAddress(a => ({ ...a, addressLine1: e.target.value }))} />
                  </div>
                  <div>
                    <label style={mini}>City / Suburb</label>
                    <input style={S.input} value={shipAddress.city} onChange={e => setShipAddress(a => ({ ...a, city: e.target.value }))} />
                  </div>
                  <div>
                    <label style={mini}>State</label>
                    <input style={S.input} value={abbrevState(shipAddress.stateOrProvince)} onChange={e => setShipAddress(a => ({ ...a, stateOrProvince: abbrevState(e.target.value) }))} placeholder="QLD" />
                  </div>
                  <div>
                    <label style={mini}>Postcode</label>
                    <input style={S.input} value={shipAddress.postalCode} onChange={e => setShipAddress(a => ({ ...a, postalCode: e.target.value }))} />
                  </div>
                  <div>
                    <label style={mini}>Country</label>
                    <input style={{ ...S.input, maxWidth: 90 }} value={shipAddress.country} onChange={e => setShipAddress(a => ({ ...a, country: e.target.value.toUpperCase() }))} maxLength={2} placeholder="AU" />
                  </div>
                </div>
              )
            })()}
            <button
              style={{ ...S.btn('primary'), width: '100%', opacity: (savingLocation || !ebayConnected) ? 0.6 : 1 }}
              onClick={saveShipAddressAndCreateLocation}
              disabled={savingLocation || !ebayConnected}
            >
              {savingLocation ? 'Saving…' : ebayLocationKey ? 'Update eBay Location' : 'Save & Create eBay Location'}
            </button>
            {!ebayConnected && <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>Connect eBay above first.</div>}
            {locationMsg && (
              <div style={{ marginTop: 10, fontSize: 13, color: locationMsg.ok ? C.green : C.red }}>
                {locationMsg.ok ? '✓ ' : '✗ '}{locationMsg.msg}
              </div>
            )}
          </Section>

          {/* Parse make/model/year now runs automatically as a phase of every sync
              — the standalone button was removed. */}

          </div>{/* end left column */}

          {/* RIGHT COLUMN */}
          <div>
            {/* Import */}
            <Section title="📥 eBay Sync">
              {/* Sync dashboard — tacho (activity), speedo + odometer (progress), step flags */}
              {(() => {
                const active = importJob?.status === 'running'
                const done   = importJob?.status === 'completed'
                const pct    = done ? 100 : (active ? displayProgress : 0)
                const tacho  = done ? 0 : (active ? rpm : 0)

                const MIN_A = 150, SWEEP_A = 240
                const toRad = a => a * Math.PI / 180
                const ptOn = (cx, cy, r, a) => [cx + r * Math.cos(toRad(a)), cy + r * Math.sin(toRad(a))]
                const arcD = (cx, cy, r, a1, span) => {
                  const [x1, y1] = ptOn(cx, cy, r, a1)
                  const [x2, y2] = ptOn(cx, cy, r, a1 + span)
                  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
                }
                // One round gauge (tacho or speedo) drawn into the shared SVG.
                const Gauge = ({ cx, cy, r, value, max, color, label, unit }) => {
                  const span = (Math.min(Math.max(value, 0), max) / max) * SWEEP_A
                  const nA = toRad(MIN_A + span)
                  const [nx, ny] = ptOn(cx, cy, r - 7, MIN_A + span)
                  const [bx, by] = [cx - 7 * Math.cos(nA), cy - 7 * Math.sin(nA)]
                  return (
                    <g>
                      <circle cx={cx} cy={cy} r={r + 7} fill="#161616" stroke="#2a2a2a" strokeWidth="1.5" />
                      <path d={arcD(cx, cy, r, MIN_A, SWEEP_A)} fill="none" stroke="#262626" strokeWidth="5" strokeLinecap="round" />
                      {span > 1 && <path d={arcD(cx, cy, r, MIN_A, span)} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" />}
                      {span > 1 && <path d={arcD(cx, cy, r, MIN_A, span)} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" opacity="0.12" />}
                      {Array.from({ length: 9 }, (_, i) => {
                        const a = MIN_A + (i / 8) * SWEEP_A, major = i % 2 === 0
                        const [x1, y1] = ptOn(cx, cy, r - (major ? 7 : 4), a)
                        const [x2, y2] = ptOn(cx, cy, r, a)
                        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3a3a3a" strokeWidth={major ? 1.4 : 0.8} />
                      })}
                      <line x1={bx.toFixed(1)} y1={by.toFixed(1)} x2={nx.toFixed(1)} y2={ny.toFixed(1)}
                        stroke="#eee" strokeWidth="2.2" strokeLinecap="round" style={{ transition: 'all 0.35s ease-out' }} />
                      <circle cx={cx} cy={cy} r="5" fill={color} />
                      <circle cx={cx} cy={cy} r="2.5" fill="#0a0a0a" />
                      <text x={cx} y={cy + 17} textAnchor="middle" fill="#e5e5e5" fontSize="13" fontWeight="700" fontFamily="monospace">
                        {Math.round(value)}{unit}
                      </text>
                      <text x={cx} y={cy + 27} textAnchor="middle" fill="#666" fontSize="7" letterSpacing="1.5">{label}</text>
                    </g>
                  )
                }

                // Steps shown as flags; the last is a checkered finish flag.
                const steps = ['IMPORT', 'SOLD', 'FEES', 'RECONCILE']
                const curStep = done ? steps.length
                  : /listing|import/i.test(syncPhase) && !/sold/i.test(syncPhase) ? 0
                  : /sold/i.test(syncPhase) ? 1
                  : /fee/i.test(syncPhase) ? 2
                  : /reconcil/i.test(syncPhase) ? 3
                  : active ? 0 : -1
                const odo = String(Math.round(pct)).padStart(3, '0')

                const rows = [...steps, 'FINISH']
                return (
                  <div style={{ marginBottom: 12, width: '100%', maxWidth: 440 }}>
                    <style>{`
                      @keyframes pvFlagWave { 0%,100% { transform: skewX(0deg) scaleX(1); } 50% { transform: skewX(-8deg) scaleX(0.9); } }
                      @keyframes pvOdoFlip { from { opacity:0.4; } to { opacity:1; } }
                    `}</style>
                    {/* Compact banner: two gauges left, flag checklist beside them right */}
                    <svg viewBox="0 0 470 132" style={{ width: '100%', display: 'block' }}>

                      {/* TACHOMETER — activity */}
                      <Gauge cx={62} cy={58} r={50} value={tacho} max={100} unit="" label="ACTIVITY"
                        color={done ? '#22c55e' : '#f59e0b'} />

                      {/* SPEEDOMETER — progress */}
                      <Gauge cx={186} cy={58} r={50} value={pct} max={100} unit="%" label="PROGRESS"
                        color={done ? '#22c55e' : active ? '#3b82f6' : '#2a3a5a'} />

                      {/* ODOMETER under the speedo */}
                      <g transform="translate(186,120)">
                        <rect x="-38" y="-11" width="76" height="22" rx="3" fill="#000" stroke="#333" strokeWidth="1" />
                        {odo.split('').map((d, i) => (
                          <g key={i} transform={`translate(${-25 + i * 19}, 0)`}>
                            <rect x="-8.5" y="-9" width="17" height="18" rx="2" fill="#1a1a1a" stroke="#2e2e2e" strokeWidth="0.6" />
                            <text x="0" y="6" textAnchor="middle" fill="#ffb347" fontSize="15" fontWeight="800"
                              fontFamily="monospace" style={{ animation: active ? 'pvOdoFlip 0.4s ease' : 'none' }}>{d}</text>
                          </g>
                        ))}
                      </g>

                      {/* FLAG CHECKLIST — beside the gauges, vertical */}
                      <g transform="translate(300,6)">
                        {rows.map((s, i) => {
                          const y = 8 + i * 24
                          const isFinish = i === steps.length
                          const reached = isFinish ? done : curStep > i
                          const current = isFinish ? false : (curStep === i && !done)
                          const col = reached ? '#22c55e' : current ? '#f59e0b' : '#555'
                          return (
                            <g key={s} transform={`translate(0,${y})`}>
                              <line x1="0" y1="-9" x2="0" y2="9" stroke="#666" strokeWidth="1.5" />
                              <g transform="translate(0,-9)" style={{ transformOrigin: '0px 0px', animation: current || (isFinish && done) ? 'pvFlagWave 0.85s ease-in-out infinite' : 'none' }}>
                                {isFinish ? (
                                  Array.from({ length: 3 }).map((_, r) => Array.from({ length: 5 }).map((__, c) => (
                                    <rect key={`${r}-${c}`} x={2 + c * 3.6} y={r * 3.6} width="3.6" height="3.6"
                                      fill={(r + c) % 2 === 0 ? (done ? '#fff' : '#555') : (done ? '#111' : '#262626')} />
                                  )))
                                ) : (
                                  <path d="M2,0 L20,0 L17,5 L20,10 L2,10 Z" fill={col} opacity={reached || current ? 1 : 0.55} />
                                )}
                                {reached && !isFinish && <text x="9" y="8" fontSize="8" fill="#0e2a12" fontWeight="900">✓</text>}
                              </g>
                              <text x="26" y="2" fill={col} fontSize="11" fontWeight="700" letterSpacing="0.3"
                                style={{ alignmentBaseline: 'middle' }}>{s}</text>
                            </g>
                          )
                        })}
                      </g>
                    </svg>

                    {/* Current-phase caption */}
                    <div style={{ padding: '3px 4px 0', textAlign: 'center',
                      fontSize: 10, color: done ? '#22c55e' : active ? C.text : C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {done ? '🏁 Sync complete' : active ? (syncPhase || importJob?.current_item || 'Working…') : 'Idle — ready to sync'}
                    </div>
                  </div>
                )
              })()}

              {/* Live sync-health checker */}
              {ebayConnected && (() => {
                const s = syncStatus
                const inSync = s && !s.error && s.outOfSync === 0
                const bg = !s || s.error ? '#f9f8f5' : inSync ? '#ecfdf5' : '#fffbeb'
                const border = !s || s.error ? C.border : inSync ? '#a7f3d0' : '#fcd34d'
                return (
                  <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
                        {statusLoading ? '⏳ Checking sync…'
                          : !s ? 'Sync status'
                          : s.error ? '⚠ Could not check'
                          : inSync ? '✓ In sync with eBay'
                          : `⚠ ${s.outOfSync} item${s.outOfSync === 1 ? '' : 's'} out of sync`}
                      </div>
                      <span style={{ fontSize: 11, color: C.muted }}>Auto-checked after each sync</span>
                    </div>
                    {s && !s.error && (
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
                        {s.stale} listed here but ended on eBay · {s.missing} on eBay not here · {s.ebayActive} active on eBay vs {s.pvActive} here
                        {s.outOfSync > 0 && <> — <button onClick={openReconcile} style={{ background: 'none', border: 'none', padding: 0, color: C.accent, cursor: 'pointer', fontWeight: 600, textDecoration: 'underline', fontSize: 'inherit', fontFamily: 'inherit' }}>Review &amp; resolve →</button></>}
                        {s.checkedAt && (() => {
                          const mins = Math.floor((Date.now() - new Date(s.checkedAt).getTime()) / 60000)
                          const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`
                          return <span style={{ color: '#9ca3af' }}> · checked {ago}</span>
                        })()}
                      </div>
                    )}
                    {s?.statusBreakdown && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                        Our listings by status: {Object.entries(s.statusBreakdown).map(([k, v]) => `${k} ${v}`).join(' · ')}{s.version ? ` · fn ${s.version}` : ''}
                      </div>
                    )}
                    {s?.error && <div style={{ fontSize: 12, color: C.red, marginTop: 6 }}>{s.error}</div>}
                  </div>
                )
              })()}

              {/* Auto-sync frequency — how often the full eBay sync runs. */}
              {ebayConnected && (
                <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>🔄 Auto-sync every</span>
                    <select value={syncInterval} onChange={e => saveSyncInterval(e.target.value)} title="How often the full eBay sync runs automatically (import + sold orders + reconcile)"
                      style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, background: '#fff' }}>
                      <option value={3}>3 hours</option>
                      <option value={6}>6 hours</option>
                      <option value={12}>12 hours</option>
                      <option value={24}>24 hours (nightly)</option>
                    </select>
                    {siSaved && <span style={{ fontSize: 12, color: C.green }}>✓ saved</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Runs at each interval in your store's timezone. More frequent = ended/sold statuses (and the out-of-sync count above) clear faster.</div>
                </div>
              )}

              {/* Sales audit (advanced) — on-demand check of recorded sales vs eBay for a
                  specific date range. Routine whole-DB sales matching is now part of Sync
                  (the idempotent sold-order import), so this is only for spot-checking a period. */}
              {showAdvSync && ebayConnected && (
                <div style={{ background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>💰 Audit sales vs eBay (period)</div>
                    <button onClick={checkSalesMatch} disabled={salesMatchLoading} style={{ ...S.btn('secondary'), padding: '5px 12px', fontSize: 12, opacity: salesMatchLoading ? 0.6 : 1 }}>
                      {salesMatchLoading ? 'Checking eBay…' : 'Check sales match'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap', fontSize: 12, color: C.muted }}>
                    <span>From</span>
                    <input type="date" value={smFrom} max={smTo} onChange={e => setSmFrom(e.target.value)}
                      style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 6px', fontSize: 12 }} />
                    <span>to</span>
                    <input type="date" value={smTo} min={smFrom} onChange={e => setSmTo(e.target.value)}
                      style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 6px', fontSize: 12 }} />
                    <span style={{ color: C.muted }}>· match eBay's report window exactly (your local dates)</span>
                  </div>
                  {salesMatch?.error && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{salesMatch.error}</div>}
                  {salesMatch && !salesMatch.error && (() => {
                    const itemMiss = salesMatch.missingSales || 0
                    const itemGap = (salesMatch.ebayItemTotal || 0) - (salesMatch.ourItemTotal || 0)
                    const matched = itemMiss === 0 && Math.abs(itemGap) < Math.max(20, salesMatch.ebayItemTotal * 0.005)
                    return (
                      <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.6 }}>
                        <div><strong>eBay</strong> ({salesMatch.ebayItems} items / {salesMatch.ebayOrders} orders{salesMatch.ebayCancelled ? `, ${salesMatch.ebayCancelled} cancelled` : ''}):</div>
                        <div style={{ marginLeft: 10, color: C.muted }}>
                          item {fmt(salesMatch.ebayItemTotal)} + shipping {fmt(salesMatch.ebayShipping)}
                          {salesMatch.ebayDiscount > 0 && <> − discount {fmt(salesMatch.ebayDiscount)}</>}
                          {salesMatch.ebayAdjustment ? <> + adj {fmt(salesMatch.ebayAdjustment)}</> : null}
                          {salesMatch.ebayTax > 0 && <> + tax {fmt(salesMatch.ebayTax)}</>}
                          {' '}= <strong style={{ color: C.text }}>{fmt(salesMatch.ebayPaidTotal)}</strong>
                          {Math.abs(salesMatch.ebayUnexplained || 0) >= 1 && (
                            <span style={{ color: '#b45309' }}> · {fmt(Math.abs(salesMatch.ebayUnexplained))} unexplained (not in eBay's discount/adj fields)</span>
                          )}
                        </div>
                        <div style={{ marginTop: 4 }}><strong>PartVault</strong> ({salesMatch.ourCount} items):</div>
                        <div style={{ marginLeft: 10, color: C.muted }}>item {fmt(salesMatch.ourItemTotal)} + shipping {fmt(salesMatch.ourShipping)} = <strong style={{ color: C.text }}>{fmt((salesMatch.ourItemTotal || 0) + (salesMatch.ourShipping || 0))}</strong></div>
                        <div style={{ marginTop: 6, color: matched ? C.green : '#b45309' }}>
                          {matched
                            ? `✓ Item + shipping totals agree with eBay to the cent (${salesMatch.ebayItems} items). eBay's headline total of ${fmt(salesMatch.ebayPaidTotal)} differs only by eBay-reported ${fmt(salesMatch.ebayDiscount)} discount${salesMatch.ebayTax > 0 ? `, ${fmt(salesMatch.ebayTax)} GST` : ''}${Math.abs(salesMatch.ebayUnexplained || 0) >= 1 ? `, and ${fmt(Math.abs(salesMatch.ebayUnexplained))} not accounted for by either` : ''}.`
                            : `⚠ ${itemMiss} item${itemMiss === 1 ? '' : 's'} on eBay not recorded here${itemGap ? ` (~${fmt(itemGap)} item value)` : ''}. Run Sync / Import sold history to capture them.`}
                        </div>
                        {salesMatch.residualOrders?.length > 0 && (
                          <details style={{ marginTop: 8 }}>
                            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#b45309', fontWeight: 600 }}>
                              Show {salesMatch.residualCount} order{salesMatch.residualCount === 1 ? '' : 's'} that don't reconcile (the {fmt(Math.abs(salesMatch.ebayUnexplained))} unexplained)
                            </summary>
                            <div style={{ marginTop: 6, maxHeight: 240, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                              {salesMatch.residualOrders.map((o, i) => (
                                <div key={i} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                    <a href={`https://www.ebay.com.au/sh/ord/details?orderid=${o.orderId}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'monospace', color: C.blue, textDecoration: 'none' }}>{o.orderId}</a>
                                    <span style={{ color: Math.abs(o.residual) >= 0.01 ? '#b45309' : C.muted, fontWeight: 700 }}>{o.residual > 0 ? '+' : ''}{fmt(o.residual)}</span>
                                  </div>
                                  <div style={{ color: C.muted, marginTop: 2 }}>
                                    item {fmt(o.subtotal)} + ship {fmt(o.shipping)} + tax {fmt(o.tax)} − disc {fmt(o.discount)}{o.adjustment ? ` + adj ${fmt(o.adjustment)}` : ''} ≠ total {fmt(o.total)}
                                    {o.paymentStatus ? ` · ${o.paymentStatus}` : ''}
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                              These eBay orders' own pricing fields don't add up — the gap usually means a partial refund, a coupon eBay didn't itemise, or a currency-conversion rounding. Open one on eBay to see which.
                            </div>
                          </details>
                        )}
                        {salesMatch.missingItems?.length > 0 && (
                          <details style={{ marginTop: 8 }}>
                            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#b45309', fontWeight: 600 }}>
                              Show {salesMatch.missingCount} missing sale{salesMatch.missingCount === 1 ? '' : 's'} (~{fmt(salesMatch.missingValue)})
                            </summary>
                            <div style={{ marginTop: 6, maxHeight: 220, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                              {salesMatch.missingItems.map((m, i) => (
                                <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 8px', borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                                  <span style={{ color: C.muted, fontFamily: 'monospace', flexShrink: 0 }}>{m.legacyItemId || m.sku || '—'}</span>
                                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title || 'eBay sale'}</span>
                                  <span style={{ flexShrink: 0, color: C.text }}>{fmt(m.price)}</span>
                                </div>
                              ))}
                            </div>
                            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                              These eBay sales have no distinct sold part here (likely a relisted/duplicate SKU whose later sale overwrote the earlier one). Run a sold-orders import to recreate them.
                            </div>
                          </details>
                        )}
                        <div style={{ marginTop: 4, fontSize: 11, color: C.muted }}>
                          Source: eBay getOrders · fn {salesMatch.version}
                          {salesMatch.windowFrom && ` · ${new Date(salesMatch.windowFrom).toLocaleDateString('en-AU')} – ${new Date(salesMatch.windowTo).toLocaleDateString('en-AU')}`}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

              <div style={{ marginBottom: syncPhase ? 6 : 12 }}>
                <button style={{ ...S.btn('primary'), width: '100%', opacity: (syncingAll || !ebayConnected) ? 0.6 : 1 }} onClick={runSync} disabled={syncingAll || importing || backfilling || reconciling || !ebayConnected}>
                  {syncingAll ? '⏳ Syncing…' : '🔄 Sync now'}
                </button>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
                  One pass to match eBay: imports listings, sold orders &amp; fees, fills make/model from titles, then reconciles &amp; auto-resolves ended/sold items. Read-only; keeps running in the background even if you leave this page.
                </div>
              </div>
              {syncPhase && (
                <div style={{ fontSize: 12, color: syncPhase.startsWith('✓') ? C.green : syncPhase.startsWith('Sync stopped') ? C.red : C.text, marginBottom: 8, padding: '6px 10px', background: syncPhase.startsWith('✓') ? '#ecfdf5' : syncPhase.startsWith('Sync stopped') ? '#fef2f2' : C.bg, borderRadius: 6, border: `1px solid ${syncPhase.startsWith('✓') ? '#a7f3d0' : syncPhase.startsWith('Sync stopped') ? '#fecaca' : C.border}` }}>
                  {syncPhase}
                </div>
              )}
              {(() => {
                const ok = lastSync ? lastSync.ok !== false : true
                const lsTs = lastSync?.synced_at ? new Date(lastSync.synced_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
                const inProgress = nightly && !nightly.done
                const nightlyTs = nightly?.updated_at ? new Date(nightly.updated_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
                const kindLbl = lastSync?.kind === 'nightly' ? ' (nightly)' : lastSync?.kind === 'manual' ? ' (manual)' : lastSync?.kind === 'live' ? ' (live check)' : ''
                return (
                  <div style={{ fontSize: 11, marginBottom: 8, padding: '6px 10px', borderRadius: 6,
                    background: !lastSync ? '#f9f8f5' : ok ? '#ecfdf5' : '#fef2f2',
                    border: `1px solid ${!lastSync ? C.border : ok ? '#a7f3d0' : '#fecaca'}`,
                    color: C.text, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span>
                      {lastSync
                        ? <>{ok ? '✓' : '⚠'} <strong>Last sync:</strong> {lsTs}{kindLbl}{lastSync.summary ? ` · ${lastSync.summary}` : ''}</>
                        : <>🌙 <strong>Sync:</strong> no run recorded yet — nightly runs at your local midnight</>}
                      {inProgress && <><br />⏳ Nightly in progress · {nightly.phase}{nightly.detail ? ` · ${nightly.detail}` : ''} (as of {nightlyTs})</>}
                    </span>
                    <button onClick={fetchNightly} style={{ ...S.btn('secondary'), padding: '3px 10px', fontSize: 11 }}>↻</button>
                  </div>
                )
              })()}
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>One click imports new listings, updates sold orders (last ~4 months), then reconciles against eBay. It only reads from eBay — it never changes your live listings.</div>
              <div style={{ fontSize: 11, color: C.green, marginBottom: 8 }}>🌙 Auto-syncs every night around midnight (Sydney) — no need to click unless you want an update now.</div>

              <button onClick={() => setShowAdvSync(v => !v)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', fontSize: 12, padding: '2px 0', marginBottom: showAdvSync ? 10 : 4 }}>
                {showAdvSync ? '▴ Hide one-time & maintenance tools' : '⚙ One-time & maintenance tools'}
              </button>

              {/* Maintenance tools — compact rows */}
              {showAdvSync && (
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
                  {
                    label: 'Backfill Listing Dates',
                    hint: 'Re-fetch the original eBay listing date for parts missing one.',
                    running: backfillingDates,
                    onRun: runDateBackfill,
                    onCancel: () => { backfillDateCancelRef.current = true },
                    result: backfillDateResult,
                    resultText: r => r.done
                      ? `${r.updated} dated · ${r.noData} not on eBay${r.cancelled ? ' (cancelled)' : ''}`
                      : `${r.updated || 0} dated so far…`,
                  },
                ].map(({ label, hint, running, onRun, onCancel, result, resultText }, idx, arr) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: idx < arr.length - 1 ? 10 : 0, marginBottom: idx < arr.length - 1 ? 10 : 0, borderBottom: idx < arr.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{label}</div>
                      {hint && !result && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{hint}</div>}
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
              )}
              {!ebayConnected && <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>Connect eBay above to enable.</div>}
            </Section>

            {/* One-time setup tools live behind the ⚙ toggle — CSV history import,
                historical cost model + real-fee backfill, and reconcile. */}
            {showAdvSync && (plan.can('history') ? (
              <>
                <EbayHistoryUpload storeId={storeId} canUpload={!!lastSync || !!lastRun.backfill || !!lastRun.import} />
                <HistoricalCosts storeId={storeId} />
              </>
            ) : (
              <div style={{ background: '#f9f8f5', border: `1px dashed ${C.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12, fontSize: 13, color: C.muted }}>
                🔒 Historical sales import &amp; cost modelling are part of the <b>Pro</b> plan.
              </div>
            ))}
            {showAdvSync && <div ref={reconcileRef}><ReconcileSection /></div>}
          </div>{/* end right column */}
        </div>
      )}

      {/* SKU reconcile — pull the current custom labels from eBay (moved here from
          the old eBay tab). Full-width below the sync grid. */}
      {tab === 'ebay' && (
        <div style={{ marginTop: 16 }}>
          <Section title="🔄 Reconcile SKUs from eBay">
            <SkuReconcile storeId={storeId} parts={parts} onApplied={onChanged} />
          </Section>
        </div>
      )}

      {/* Recover a recently-deleted store (owner, within the free grace window) */}
      {tab === 'account' && deletedStores.length > 0 && (
        <div style={{ ...S.card, marginTop: 20, borderColor: '#fcd34d', background: '#fffbeb' }}>
          <h3 style={{ ...S.h2, marginBottom: 8 }}>♻️ Recently deleted stores</h3>
          {deletedStores.map(d => (
            <div key={d.store_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${C.border}` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{d.store_name}</div>
                <div style={{ fontSize: 11, color: C.muted }}>
                  Deleted {new Date(d.deleted_at).toLocaleDateString()} · {d.free_restore ? 'free restore available' : 'in archive — restore needs a new 12-month plan'} · erased permanently {new Date(d.purge_after).toLocaleDateString()}
                </div>
              </div>
              <button style={{ ...S.btn('secondary'), padding: '6px 14px', fontSize: 12 }}
                onClick={async () => { try { await sb.rpc('restore_store', { p_store_id: d.store_id }); alert('Store restored.'); window.location.reload() } catch (e) { alert(e.message) } }}>
                Restore
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Danger zone — delete this store (owner only, Account tab) */}
      {tab === 'account' && isOwner && !plan.founder && (
        <div style={{ ...S.card, marginTop: 20, borderColor: '#fca5a5' }}>
          <h3 style={{ ...S.h2, marginBottom: 8, color: C.red }}>Danger zone — delete this store</h3>
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
            Removes this store and its parts, photos, inventory and sales history for everyone on the team, and stops billing.
            Your data is <b>recoverable free for 30 days</b>, then archived (restore needs a new 12-month plan) and permanently erased after your paid period + 12 months.
            <b> Your live eBay listings are NOT deleted</b> — they stay on eBay.
          </div>
          <input value={delConfirm} onChange={e => setDelConfirm(e.target.value)} placeholder={`Type "${storeName}" to confirm`}
            style={{ ...S.input, maxWidth: 320, marginBottom: 10 }} />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button disabled={delConfirm !== storeName} style={{ ...S.btn('danger'), opacity: delConfirm === storeName ? 1 : 0.5 }}
              onClick={async () => { if (!confirm('Delete this store? Recoverable free for 30 days.')) return; try { await sb.rpc('delete_store', { p_store_id: storeId, p_hard: false }); window.location.reload() } catch (e) { alert(e.message) } }}>
              Delete store
            </button>
            <button disabled={delConfirm !== storeName} style={{ ...S.btn('secondary'), color: C.red, opacity: delConfirm === storeName ? 1 : 0.5 }}
              onClick={async () => { if (!confirm('Permanently erase now? This CANNOT be undone (GDPR erasure).')) return; try { await sb.rpc('delete_store', { p_store_id: storeId, p_hard: true }); window.location.reload() } catch (e) { alert(e.message) } }}>
              Delete permanently now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
