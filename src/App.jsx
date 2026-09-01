import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import useIsMobile from './hooks/useIsMobile'
import { useAuth } from './hooks/useAuth'
import { useParts } from './hooks/useParts'
import { useSales } from './hooks/useSales'
import { useSaleWorkflow } from './hooks/useSaleWorkflow'
import { useAssessQueue } from './hooks/useAssessQueue'
import { useSyncRunner } from './hooks/useSyncRunner'
import { sb, EDGE_FN } from './lib/supabase'
import { C, S, APP_VERSION, rentPerDay, sourcingMode, usesCars } from './lib/constants'
import { MARKETPLACE_LIST, guessMarketplace, setActiveMarketplace, getActiveMarketplace } from './lib/marketplaces'
import { planState } from './lib/plan'
import { DEFAULT_LABELS } from './lib/labels'
import { WAREHOUSE_DEFAULTS } from './lib/warehouse'
import AuthScreen from './components/AuthScreen'
import Dashboard from './components/Dashboard'
import Inventory from './components/Inventory'
import Settings from './components/Settings'
import Help from './components/Help'
import FloatingHelp from './components/FloatingHelp'
import JoinStore from './components/JoinStore'
import Analytics from './components/Analytics'
import Sales from './components/Sales'
import TableSizeControl from './components/TableSizeControl'
import { applyTableZoom, getTableZoom, injectTableScrollStyles } from './lib/tableZoom'

// Apply the saved table text-size as early as possible so tables render at the
// chosen size on first paint (before any component mounts), and inject the
// always-visible scrollbar styling used by every table's scroll container.
applyTableZoom(getTableZoom())
injectTableScrollStyles()

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'sales', label: 'Sales', icon: '🧾' },
  { id: 'inventory', label: 'Inventory', icon: '📦' },
  { id: 'analytics', label: 'Analytics', icon: '📈' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'help', label: 'Help', icon: '🆘' },
]

const DEFAULT_AI_SETTINGS = {
  includeMake: true, includeModel: true, includeSeries: true, includeYearRange: true,
  descriptionLength: 'medium', includeInstallLink: false, installLinkUrl: '',
  includePartNumber: true, includeConditionDetail: true, customPromptNotes: '',
}

const DEFAULT_FOOTER = `At Cloud9 Auto Parts, we aim to make your buying experience as simple and reliable as possible. All photos shown are of the exact part you will receive, no stock images. We clearly list the compatible models and year ranges in each title, but we always recommend double checking fitment by comparing photos, part numbers, and your own research.
All parts are genuine used OEM components unless stated otherwise. As they are pre-owned, some items may show minor wear, which we highlight clearly in the photos. Everything we have in stock is listed here on our eBay store.
Some parts, such as ECUs or stereos, may require a security code from the vehicle manufacturer. Steering wheels are sold without airbags due to shipping restrictions.
Shipping:
All items are posted first thing each morning. Orders placed after the daily dispatch time will be shipped the following morning, and tracking will be provided through eBay once your order is on its way.
Please note that we do not offer local pickup.
If you have any questions, feel free to send a message. I'll always do my best to help and ensure you're completely satisfied with your purchase.`

function SyncBadge({ status }) {
  const map = { live: ['●', 'Live', C.green], connecting: ['●', 'Connecting', '#f59e0b'], error: ['●', 'Error', C.red] }
  const [icon, label, color] = map[status] || map.connecting
  return <span style={{ fontSize: 12, color, marginLeft: 8, fontWeight: 500 }}>{icon} {label}</span>
}

function StoreSwitcher({ stores, activeStoreId, setActiveStore, refreshStores }) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [joining, setJoining] = useState(false)
  const [newName, setNewName] = useState('')
  const [newMarketplace, setNewMarketplace] = useState(guessMarketplace) // browser-guessed; user confirms
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const active = stores.find(s => s.store_id === activeStoreId)

  const createStore = async () => {
    if (!newName.trim()) return
    setBusy(true); setErr('')
    try {
      const { data, error } = await sb.rpc('create_store', { p_name: newName.trim() })
      if (error) throw error
      // Stamp the confirmed marketplace (+ browser timezone) on the new store.
      // It locks permanently once the first part is created (DB trigger).
      let tz = ''
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { /* optional */ }
      // New stores start with no cost applied to parts — pure eBay revenue until
      // the seller turns on the cost base in Settings → Costs.
      // A brand-new store, so writing the whole settings object is right here —
      // there is nothing to merge with. The error is not optional though: if
      // this fails silently the seller lands in a store with no marketplace and
      // no costing flag, and the first thing they notice is a listing in the
      // wrong currency.
      const { error: cfgErr } = await sb.from('stores')
        .update({ settings: { marketplace: newMarketplace, costing: { enabled: false }, ...(tz ? { timezone: tz } : {}) } })
        .eq('id', data).select('id')
      if (cfgErr) throw new Error(`Store created, but its settings could not be saved: ${cfgErr.message}`)
      await refreshStores(data) // data = new store id -> switch to it
      setNewName(''); setCreating(false); setOpen(false)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const joinStore = async () => {
    if (!joinCode.trim()) return
    setBusy(true); setErr('')
    try {
      const { data, error } = await sb.rpc('join_store', { p_join_code: joinCode.trim() })
      if (error) throw error
      await refreshStores(data)
      setJoinCode(''); setJoining(false); setOpen(false)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  if (!stores || stores.length === 0) return null

  // Warn before switching stores while a part editor is open — its unsaved
  // changes belong to the current store and would be lost.
  const switchTo = (id) => {
    if (id === activeStoreId) { setOpen(false); return }
    if (window.__pvPartOpen && !window.confirm('You have a part open. Switch stores anyway?\n\nUnsaved changes to it will be lost — click Cancel to go back and save first.')) return
    setActiveStore(id); setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', color: '#fff', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
        🏪 {active?.store_name || 'Select store'} <span style={{ opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => { setOpen(false); setCreating(false); setJoining(false); setErr('') }} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, minWidth: 270, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.18)', zIndex: 51, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Your stores</div>
            {stores.map(s => {
              const isActive = s.store_id === activeStoreId
              return (
                <button key={s.store_id} onClick={() => switchTo(s.store_id)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', background: isActive ? '#fff4ef' : '#fff', border: 'none', borderTop: `1px solid ${C.border}`, padding: '10px 12px', cursor: 'pointer' }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: C.text }}>{s.store_name}</span>
                    <span style={{ display: 'block', fontSize: 11, color: C.muted }}>{s.ebay_connected ? `eBay: ${s.ebay_user || 'connected'}` : 'eBay not connected'} · {s.role}</span>
                  </span>
                  {isActive && <span style={{ color: C.accent, fontWeight: 800 }}>✓</span>}
                </button>
              )
            })}
            {creating ? (
              <div style={{ borderTop: `1px solid ${C.border}`, padding: 10 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') createStore(); if (e.key === 'Escape') { setCreating(false); setNewName(''); setErr('') } }}
                    placeholder="New store name" style={{ flex: 1, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none' }} />
                  <button onClick={createStore} disabled={busy || !newName.trim()}
                    style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (busy || !newName.trim()) ? 0.6 : 1 }}>{busy ? '…' : 'Create'}</button>
                  <button onClick={() => { setCreating(false); setNewName(''); setErr('') }} title="Cancel — back to the store list"
                    style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, color: C.muted, cursor: 'pointer' }}>✕</button>
                </div>
                <select value={newMarketplace} onChange={e => setNewMarketplace(e.target.value)}
                  style={{ width: '100%', marginTop: 6, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', background: '#fff' }}>
                  {MARKETPLACE_LIST.map(m => <option key={m.id} value={m.id}>{m.flag} {m.label} — eBay ({m.currency})</option>)}
                </select>
                <div style={{ fontSize: 10.5, color: C.muted, marginTop: 5, lineHeight: 1.4 }}>Which eBay marketplace this store sells on. Locks once the first part is created — a different country needs its own store.</div>
                {err && <div style={{ fontSize: 11, color: C.red, marginTop: 6 }}>{err}</div>}
              </div>
            ) : joining ? (
              <div style={{ borderTop: `1px solid ${C.border}`, padding: 10 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input autoFocus value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === 'Enter') joinStore(); if (e.key === 'Escape') { setJoining(false); setJoinCode(''); setErr('') } }}
                    placeholder="Join code" style={{ flex: 1, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'monospace', fontWeight: 700, letterSpacing: 1 }} />
                  <button onClick={joinStore} disabled={busy || !joinCode.trim()}
                    style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (busy || !joinCode.trim()) ? 0.6 : 1 }}>{busy ? '…' : 'Join'}</button>
                  <button onClick={() => { setJoining(false); setJoinCode(''); setErr('') }} title="Cancel — back to the store list"
                    style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, color: C.muted, cursor: 'pointer' }}>✕</button>
                </div>
                {err && <div style={{ fontSize: 11, color: C.red, marginTop: 6 }}>{err}</div>}
              </div>
            ) : (
              <div style={{ display: 'flex', borderTop: `1px solid ${C.border}` }}>
                <button onClick={() => { setCreating(true); setErr('') }}
                  style={{ flex: 1, textAlign: 'left', background: '#fafaf9', border: 'none', padding: '10px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.accent }}>＋ New store</button>
                <button onClick={() => { setJoining(true); setErr('') }}
                  style={{ flex: 1, textAlign: 'left', background: '#fafaf9', border: 'none', borderLeft: `1px solid ${C.border}`, padding: '10px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.accent }}>↪ Join store</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Rough ETA text from a millisecond estimate.
const fmtEta = (ms) => { if (ms == null || ms <= 0) return ''; const s = Math.round(ms / 1000); return s < 60 ? `~${s}s left` : `~${Math.round(s / 60)} min left` }

// Compact background-assessment indicator for the nav bar. Shows live progress +
// ETA while the queue runs, the auto-retry countdown when it's waiting, a blocked
// state (migration needed), a paused state, and a pause/resume toggle. Hidden when
// there's nothing to prepare and nothing running.
function AssessBadge({ assess }) {
  const { running, done, total, paused, togglePaused, remaining, etaMs, retrySec, blocked } = assess || {}
  if (!running && !remaining) return null
  const isBlocked = blocked === 'ebay-specifics' || blocked === 'ai-credit'
  const label = running
    ? `Preparing ${done}/${total}${fmtEta(etaMs) ? ' · ' + fmtEta(etaMs) : ''}`
    : blocked === 'ai-credit'
      ? `${remaining} paused · AI credit`
      : blocked === 'ebay-specifics'
        ? `${remaining} waiting · needs migration`
        : paused
          ? `${remaining} to prepare · paused`
          : retrySec != null
            ? `${remaining} waiting · retry in ${retrySec}s`
            : `${remaining} to prepare`
  const icon = running ? '🧠' : isBlocked ? '⚠' : paused ? '⏸' : '🧠'
  const bg = isBlocked ? 'rgba(245,158,11,0.22)' : 'rgba(255,255,255,0.12)'
  const border = isBlocked ? 'rgba(245,158,11,0.5)' : 'rgba(255,255,255,0.2)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: bg, border: `1px solid ${border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}
          title={blocked === 'ai-credit'
            ? 'Anthropic AI credit is exhausted — top up billing at console.anthropic.com, then reload.'
            : blocked === 'ebay-specifics'
              ? 'eBay specifics can’t be saved — run migration 20260718_parts_ebay_specifics.sql, then reload.'
              : 'Background: AI assessment + eBay item specifics for new parts'}>
      <span style={running ? { animation: 'spin 1s linear infinite', display: 'inline-block' } : undefined}>{icon}</span>
      {label}
      <button onClick={togglePaused} title={paused ? 'Resume background preparation' : 'Pause background preparation'}
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 12, padding: 0, marginLeft: 2 }}>
        {paused ? '▶' : '⏸'}
      </button>
    </span>
  )
}

// Global eBay-sync progress chip. Shows live phase + % and a cancel button in the
// nav bar while a full "Sync now" runs, so the run keeps going (and stays visible)
// when the user leaves the Settings tab. Hidden when idle. Driven by useSyncRunner.
function SyncProgressBadge({ sync }) {
  const { running, progress, phase, cancel } = sync || {}
  if (!running) return null
  const pct = Math.round(progress || 0)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(59,130,246,0.22)', border: '1px solid rgba(59,130,246,0.5)', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.95)' }}
          title={phase || 'Syncing with eBay…'}>
      <span style={{ animation: 'spin 1.4s linear infinite', display: 'inline-block' }}>🔄</span>
      eBay sync {pct}%
      <button onClick={cancel} title="Cancel — stops the foreground sync (the server may still finish this pass)"
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 12, padding: 0, marginLeft: 2 }}>
        ✕
      </button>
    </span>
  )
}

// Opt-in AI-assessment prompt. When a store loads with un-assessed parts, ask
// once (per login / store switch) whether to assess All / Some / None, instead of
// the queue silently running. "Choose some" opens a checklist. Making any choice
// clears assess.promptNeeded, which closes this.
function AssessPrompt({ assess, storeName, loading }) {
  const [choosing, setChoosing] = useState(false)
  const [sel, setSel] = useState(() => new Set())
  const pending = assess?.pending || []
  useEffect(() => { if (!assess?.promptNeeded) setChoosing(false) }, [assess?.promptNeeded])
  if (loading || !assess?.promptNeeded) return null
  const n = pending.length
  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 20 }
  const card = { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 520, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }
  const linkBtn = { background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontWeight: 600, fontSize: 12, padding: 0, textDecoration: 'underline' }

  if (!choosing) return (
    <div style={overlay}>
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 8 }}>🧠 Assess with AI?</div>
        <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6, marginBottom: 18 }}>
          <b>{n}</b> part{n === 1 ? '' : 's'} in <b>{storeName}</b> {n === 1 ? 'is' : 'are'} ready to be AI-assessed — title, category, price, condition &amp; eBay specifics. Each part uses AI credits.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button onClick={() => assess.assessNone()} style={{ ...S.btn('secondary'), padding: '9px 16px' }}>Not now</button>
          <button onClick={() => { setSel(new Set(pending.map(p => p.id))); setChoosing(true) }} style={{ ...S.btn('secondary'), padding: '9px 16px' }}>Choose some…</button>
          <button onClick={() => assess.assessAll()} style={{ ...S.btn('primary'), padding: '9px 16px' }}>Assess all {n}</button>
        </div>
      </div>
    </div>
  )

  const toggle = (id) => setSel(s => { const nx = new Set(s); nx.has(id) ? nx.delete(id) : nx.add(id); return nx })
  return (
    <div style={overlay}>
      <div style={{ ...card, maxWidth: 580, display: 'flex', flexDirection: 'column', maxHeight: '82vh' }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 4 }}>Choose parts to assess</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, color: C.muted, marginBottom: 10 }}>
          <span>{sel.size} of {n} selected</span>
          <button onClick={() => setSel(new Set(pending.map(p => p.id)))} style={linkBtn}>Select all</button>
          <button onClick={() => setSel(new Set())} style={linkBtn}>Clear</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
          {pending.map((p, i) => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: i > 0 ? `1px solid ${C.border}` : 'none', cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
              <span style={{ fontFamily: 'monospace', color: C.muted, fontSize: 11, minWidth: 60 }}>{p.sku || '—'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title || 'Untitled'}</span>
              <span style={{ color: C.muted, fontSize: 11, whiteSpace: 'nowrap' }}>{[p.make, p.model, p.year].filter(Boolean).join(' ')}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={() => setChoosing(false)} style={{ ...S.btn('secondary'), padding: '9px 16px' }}>← Back</button>
          <button disabled={sel.size === 0} onClick={() => assess.assessSome([...sel])} style={{ ...S.btn('primary'), padding: '9px 16px', opacity: sel.size === 0 ? 0.5 : 1 }}>Assess {sel.size} selected</button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { session, profile, storeId, stores, activeStoreId, setActiveStore, refreshStores, authReady, signOut } = useAuth()
  const { parts, loading, syncStatus, totalCount, listingStats, addPart, editPart, softDelete, softDeleteCar, refetch } = useParts(storeId)
  const { sales, refetchSales } = useSales(storeId)
  const { wf, setStage } = useSaleWorkflow(storeId)
  const [tab, setTab] = useState('dashboard')
  const isMobile = useIsMobile()
  const [mobMenu, setMobMenu] = useState(false) // phone header overflow menu
  const [toast, setToast] = useState(null)
  const lastFetchRef = useRef(Date.now())
  // Always the current store, so async loads for a previous store can detect they've
  // been superseded and skip their setState (prevents cross-company data bleed).
  const storeIdRef = useRef(storeId)
  storeIdRef.current = storeId
  const smartRefetch = useCallback(() => { lastFetchRef.current = Date.now(); refetch() }, [refetch])
  // Refresh on opening Inventory only if the data has gone stale (>60s) — avoids
  // re-downloading a big catalogue on every tab click while realtime keeps it warm.
  useEffect(() => {
    if (tab === 'inventory' && Date.now() - lastFetchRef.current > 60000) smartRefetch()
  }, [tab, smartRefetch])
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS)
  const [footer, setFooter] = useState(DEFAULT_FOOTER)
  const [costing, setCosting] = useState({ labourRate: 60, adminPct: 10, adminMin: 5 })
  const [inventory, setInventory] = useState({ agedThresholdDays: 60, ageBrackets: [90, 180, 365, 730, 1065] })
  const [storage, setStorage] = useState({ volumeM3: 0, rent: 0, rentPeriod: 'monthly', usablePct: 25 })
  const [shipping, setShipping] = useState(null)
  const [warehouse, setWarehouse] = useState(WAREHOUSE_DEFAULTS)
  const [sourcing, setSourcing] = useState('dismantle')   // how the store gets parts (drives car-centric vs flat views)
  const [labels, setLabels] = useState(DEFAULT_LABELS)
  const [insightsInit, setInsightsInit] = useState(null) // drill-down filter from Dashboard
  const [cars, setCars] = useState([])
  const [marketplaceId, setMarketplaceId] = useState('EBAY_AU') // re-render trigger for currency
  // The whole settings object, for the screens that need a field App does not
  // already hold individually (the financial-year rule and the store timezone).
  const [storeSettings, setStoreSettings] = useState({})
  const [plan, setPlan] = useState(() => planState(null)) // store's subscription plan (defaults open)
  const [ebayUsername, setEbayUsername] = useState(null) // for the nav "eBay store" link
  const [settingsInit, setSettingsInit] = useState(null) // banner deep-links open Settings on a specific tab

  // App-level background AI assessment — runs on any tab so parts created in the
  // admin form / mobile / import get assessed silently. Counter lives in the nav.
  const assess = useAssessQueue({ storeId, parts, cars, refetch: smartRefetch })
  // App-level eBay "Sync now" driver — lives here (not in the Settings tab) so a
  // running sync survives navigating between screens and shows a global nav chip.
  const sync = useSyncRunner({ storeId })

  // Enrich costing with the storage-facility config (rent normalised to /day) and
  // the per-category shipping box dims, so partEffectiveCost can compute storage.
  const costingFull = useMemo(() => ({
    ...costing,
    shipping: shipping || undefined,
    storage: { volumeM3: +storage.volumeM3 || 0, rentPerDay: rentPerDay(storage.rent, storage.rentPeriod), usablePct: +storage.usablePct || 0 },
  }), [costing, shipping, storage])

  // Jump to Insights pre-filtered (e.g. clicking an aged-stock bracket).
  const drillToInsights = (init) => { setInsightsInit({ ...init, _ts: Date.now() }); setTab('analytics') }

  // Name this window so the field app's "Open Admin" link returns to this tab
  useEffect(() => { window.name = 'partvault-admin' }, [])

  // Load store settings and cars on mount / when the active store changes
  useEffect(() => {
    if (!storeId) return
    // Guard against a slow load for the PREVIOUS store resolving after a switch and
    // overwriting the new store's settings/cars (cross-company bleed).
    const forStore = storeId
    const mine = () => storeIdRef.current === forStore
    // Reset to defaults so a previous store's settings don't bleed into this one
    setAiSettings(DEFAULT_AI_SETTINGS)
    setFooter(DEFAULT_FOOTER)
    setShipping(null)
    setCars([])
    setEbayUsername(null)
    // Load AI settings + footer
    sb.from('stores').select('settings, plan').eq('id', storeId).single().then(({ data }) => {
      if (!mine()) return
      setPlan(planState(data?.plan))
      setStoreSettings(data?.settings || {})
      setSourcing(sourcingMode(data?.settings))
      setEbayUsername(data?.settings?.ebayUsername || null)
      if (data?.settings?.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
      if (data?.settings?.footer) setFooter(data.settings.footer)
      if (data?.settings?.costing) setCosting(s => ({ ...s, ...data.settings.costing }))
      if (data?.settings?.inventory) setInventory(s => ({ ...s, ...data.settings.inventory }))
      if (data?.settings?.storage) setStorage(s => ({ ...s, ...data.settings.storage }))
      if (data?.settings?.warehouse) setWarehouse(s => ({ ...s, ...data.settings.warehouse }))
      if (data?.settings?.shipping) setShipping(data.settings.shipping)
      if (data?.settings?.labels) setLabels(s => ({ ...s, ...data.settings.labels }))
      // Currency/units follow the store's marketplace: set the module-level
      // active marketplace (read by fmt etc), then bump state to re-render.
      const mp = data?.settings?.marketplace || 'EBAY_AU'
      setActiveMarketplace(mp)
      setMarketplaceId(mp)
    })
    // Load cars
    sb.from('cars').select('*').eq('store_id', storeId).is('deleted_at', null).order('created_at', { ascending: false })
      .then(({ data }) => { if (mine()) setCars(data || []) })
  }, [storeId])

  const showToast = (msg, color = C.green) => { setToast({ msg, color }); setTimeout(() => setToast(null), 2500) }

  // Demo mode: any flagged row still in the store keeps the sample banner up.
  // New parts added while it's up ask "sample or permanent?" (see Inventory).
  const sampleActive = parts.some(p => p.isSample) || sales.some(s => s.isSample)
  const [removingSample, setRemovingSample] = useState(false)
  const removeSampleData = async () => {
    if (!confirm('Remove ALL sample data?\n\nEvery demo car, part, listing and sale will be permanently deleted. Anything you saved as a permanent record stays. This can\'t be undone.')) return
    setRemovingSample(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch(EDGE_FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'remove_sample_data', storeId }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Remove failed')
      showToast(`Sample data removed ✓ (${d.removed?.parts ?? 0} parts, ${d.removed?.sales ?? 0} sales)`)
      refetch(); refetchSales()
    } catch (e) { showToast(e.message, C.red) }
    setRemovingSample(false)
  }
  const handleAdd = async p => { try { await addPart(p); showToast('Part added ✓') } catch(e) { showToast(e.message, C.red); throw e } }
  const handleEdit = async p => { try { await editPart(p); showToast('Saved ✓') } catch(e) { showToast(e.message, C.red); throw e } }
  const handleDel = async id => { try { await softDelete(id); showToast('Deleted ✓', C.red) } catch(e) { showToast(e.message, C.red) } }
  const handleAddCar = car => { setCars(cs => [car, ...cs]); showToast('Car added ✓') }

  if (!authReady) return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, fontSize: 16 }}>
      <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block', fontSize: 32 }}>⚙</span>
    </div>
  )
  if (!session) return <AuthScreen />

  // Authenticated but not a member of any store yet — let them join with a code.
  if (!stores || stores.length === 0) return <JoinStore onJoined={(id) => refreshStores(id)} onSignOut={signOut} />

  const goTab = (t) => {
    const gated = t.id === 'analytics' && !plan.can('analytics')
    if (gated) { alert(`${t.label} is part of the Pro plan. Upgrade to unlock analytics.`); return }
    setTab(t.id); setMobMenu(false)
  }

  return (
    <div style={S.app}>
      {isMobile ? (
        // ── Phone chrome: compact header + a fixed bottom tab bar ──────────────
        <div style={{ background: C.headerBg, position: 'sticky', top: 0, zIndex: 100, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', paddingTop: 'calc(10px + env(safe-area-inset-top))' }}>
          <div style={{ color: '#fff', fontWeight: 800, fontSize: 16, fontFamily: "'Inter Tight',system-ui,sans-serif", whiteSpace: 'nowrap' }}>⚙ PartVault</div>
          <div style={{ flex: 1, minWidth: 0 }}><StoreSwitcher stores={stores} activeStoreId={activeStoreId} setActiveStore={setActiveStore} refreshStores={refreshStores} /></div>
          <SyncBadge status={syncStatus} />
          <button onClick={() => setMobMenu(o => !o)} aria-label="Menu" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: 8, width: 40, height: 40, fontSize: 18, cursor: 'pointer' }}>⋯</button>
          {mobMenu && (
            <>
              <div onClick={() => setMobMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 110 }} />
              <div style={{ position: 'absolute', top: '100%', right: 8, marginTop: 4, background: '#fff', border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.22)', zIndex: 111, minWidth: 210, overflow: 'hidden' }}>
                <div style={{ padding: '9px 14px', fontSize: 11.5, color: C.muted, borderBottom: `1px solid ${C.border}` }}>v{APP_VERSION} · {totalCount} parts</div>
                {ebayUsername && <a href={`https://www.${getActiveMarketplace()?.ebayDomain || 'ebay.com.au'}/usr/${encodeURIComponent(ebayUsername)}`} target="_blank" rel="noopener noreferrer" onClick={() => setMobMenu(false)} style={{ display: 'block', padding: '12px 14px', fontSize: 14, color: C.text, borderBottom: `1px solid ${C.border}` }}>🛒 View eBay store ↗</a>}
                <a href="https://app.partvault.app" target="partvault-app" onClick={() => setMobMenu(false)} style={{ display: 'block', padding: '12px 14px', fontSize: 14, color: C.text, borderBottom: `1px solid ${C.border}` }}>📱 Field App ↗</a>
                <button onClick={() => { refetch(); setMobMenu(false) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', fontSize: 14, color: C.text, background: 'none', border: 'none', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>↻ Refresh</button>
                <button onClick={() => { signOut(); setMobMenu(false) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', fontSize: 14, color: C.red, background: 'none', border: 'none', cursor: 'pointer' }}>Sign Out</button>
              </div>
            </>
          )}
        </div>
      ) : (
      <nav style={S.nav}>
        <div style={S.logo}>⚙ PartVault Admin</div>
        <StoreSwitcher stores={stores} activeStoreId={activeStoreId} setActiveStore={setActiveStore} refreshStores={refreshStores} />
        {ebayUsername && (
          <a href={`https://www.${getActiveMarketplace()?.ebayDomain || 'ebay.com.au'}/usr/${encodeURIComponent(ebayUsername)}`}
            target="_blank" rel="noopener noreferrer" title={`Open this company's eBay store (${ebayUsername})`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)', textDecoration: 'none', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, padding: '4px 9px' }}>
            🛒 eBay store ↗
          </a>
        )}
        {TABS.map(t => {
          // The Analytics tab is Pro+ — Basic sees it locked.
          const gated = t.id === 'analytics' && !plan.can('analytics')
          return (
            <button key={t.id} style={{ ...S.navBtn(tab === t.id), opacity: gated ? 0.45 : 1 }}
              onClick={() => gated ? alert(`${t.label} is part of the Pro plan. Upgrade to unlock analytics.`) : setTab(t.id)}>
              {t.icon} {t.label}{gated ? ' 🔒' : ''}
            </button>
          )
        })}
        <div style={{ marginLeft: 'auto', padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>
          {loading ? <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> : null}
          <AssessBadge assess={assess} />
          <SyncProgressBadge sync={sync} />
          <TableSizeControl />
          v{APP_VERSION} · {totalCount} parts
          <SyncBadge status={syncStatus} />
          <a href="https://app.partvault.app" target="partvault-app" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>📱 Field App ↗</a>
          <button style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={refetch}>↻ Refresh</button>
          <button style={{ background: 'rgba(220,38,38,0.2)', border: '1px solid rgba(220,38,38,0.3)', color: 'rgba(255,255,255,0.7)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12 }} onClick={signOut}>Sign Out</button>
        </div>
      </nav>
      )}
      {plan.tier === 'trial' && !plan.expired && (
        <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '8px 24px', fontSize: 13, color: '#1d4ed8', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>✨ Free trial — {Math.max(plan.trialDaysLeft ?? 0, 0)} day{(plan.trialDaysLeft ?? 0) === 1 ? '' : 's'} left with full access.</span>
          <button onClick={() => { setSettingsInit({ tab: 'account', ts: Date.now() }); setTab('settings') }}
            style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Start your subscription →
          </button>
        </div>
      )}
      {plan.expired && (
        <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '8px 24px', fontSize: 13, color: '#b91c1c', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>⏰ Your free trial has ended. Your data is safe — choose a plan to keep capturing and listing parts.</span>
          <button onClick={() => { setSettingsInit({ tab: 'account', ts: Date.now() }); setTab('settings') }}
            style={{ background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Choose a plan →
          </button>
        </div>
      )}
      {!ebayUsername && (
        <div style={{ background: '#f0f7ff', borderBottom: '1px solid #bcd7f5', padding: '8px 24px', fontSize: 13, color: '#1b5e9e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>🔌 Your eBay store isn't connected yet — connect it to import your real listings and sales.</span>
          <button onClick={() => { setSettingsInit({ tab: 'ebay', ts: Date.now() }); setTab('settings') }}
            style={{ background: '#1b5e9e', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Connect your store →
          </button>
        </div>
      )}
      {sampleActive && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fcd34d', padding: '8px 24px', fontSize: 13, color: '#92400e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>🧪 Sample data in use — the demo cars, parts and sales are here so you can explore. They're clearly flagged and never touch eBay.</span>
          <button onClick={removeSampleData} disabled={removingSample}
            style={{ background: '#92400e', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: removingSample ? 'default' : 'pointer', opacity: removingSample ? 0.6 : 1 }}>
            {removingSample ? '⏳ Removing…' : 'Remove sample data'}
          </button>
        </div>
      )}
      <main style={isMobile ? { padding: '14px 12px calc(80px + env(safe-area-inset-bottom))' } : S.main} key={marketplaceId}>{/* re-mounts content when the active store's currency changes */}
        {tab === 'dashboard' && <Dashboard parts={parts} sales={sales} costing={costingFull} inventory={inventory} listingStats={listingStats} storeId={storeId} onDrill={drillToInsights} onSeeSales={() => setTab('sales')} />}
        {tab === 'sales' && <Sales sales={sales} parts={parts} costing={costingFull} wf={wf} setStage={setStage} storeSettings={storeSettings} />}
        {tab === 'inventory' && (
          <Inventory
            parts={parts} cars={cars} storeId={storeId}
            onAdd={handleAdd} onEdit={handleEdit} onDelete={handleDel}
            onDeleteCar={softDeleteCar} onAddCar={handleAddCar}
            aiSettings={aiSettings} footer={footer} costing={costingFull} labels={labels} warehouse={warehouse} refetch={smartRefetch}
            assess={assess} sampleActive={sampleActive}
          />
        )}
        {tab === 'analytics' && <Analytics storeId={storeId} initial={insightsInit} parts={parts} cars={cars} sales={sales} costing={costingFull} showCars={usesCars({ sourcing })}
          onVehiclesChanged={() => { refetch(); sb.from('cars').select('*').eq('store_id', storeId).is('deleted_at', null).order('created_at', { ascending: false }).then(({ data }) => setCars(data || [])) }} />}
        {tab === 'settings' && <Settings profile={profile} storeId={storeId} onSignOut={signOut} refreshStores={refreshStores} parts={parts} onChanged={smartRefetch} sync={sync} initialTab={settingsInit}
          onSettingsSaved={s => { if (s?.costing) setCosting(c => ({ ...c, ...s.costing })); if (s?.inventory) setInventory(i => ({ ...i, ...s.inventory })); if (s?.storage) setStorage(st => ({ ...st, ...s.storage })); if (s?.shipping) setShipping(s.shipping); if (s?.warehouse) setWarehouse(w => ({ ...w, ...s.warehouse })); if (s?.labels) setLabels(l => ({ ...l, ...s.labels })) }} />}
        {tab === 'help' && <Help storeId={storeId} />}
      </main>
      {/* Opt-in AI-assessment prompt on login / store switch when parts need assessing */}
      <AssessPrompt assess={assess} storeName={stores?.find(s => s.id === storeId)?.name || 'this store'} loading={loading} />

      {/* Floating context-aware help on every page (hidden on the Help tab itself) */}
      {tab !== 'help' && <FloatingHelp storeId={storeId} context={TABS.find(t => t.id === tab)?.label || tab} onOpenHelp={() => setTab('help')} />}
      {toast && (
        <div style={{ position: 'fixed', bottom: isMobile ? 84 : 24, right: isMobile ? '50%' : 24, transform: isMobile ? 'translateX(50%)' : 'none', background: toast.color, color: '#fff', padding: '12px 22px', borderRadius: 10, fontSize: 14, fontWeight: 600, zIndex: 1000, boxShadow: '0 8px 30px rgba(0,0,0,0.2)', whiteSpace: 'nowrap' }}>
          {toast.msg}
        </div>
      )}

      {/* Fixed bottom tab bar — the phone's primary navigation */}
      {isMobile && (
        <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90, background: C.headerBg, display: 'flex', borderTop: '1px solid rgba(255,255,255,0.12)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {TABS.map(t => {
            const on = tab === t.id
            const gated = t.id === 'analytics' && !plan.can('analytics')
            return (
              <button key={t.id} onClick={() => goTab(t)}
                style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 2px 7px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: on ? C.accentOnDark : 'rgba(255,255,255,0.6)', opacity: gated ? 0.5 : 1 }}>
                <span style={{ fontSize: 19, lineHeight: 1 }}>{t.icon}</span>
                <span style={{ fontSize: 10, fontWeight: on ? 700 : 500, whiteSpace: 'nowrap' }}>{t.label}{gated ? ' 🔒' : ''}</span>
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}
