import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAuth } from './hooks/useAuth'
import { useParts } from './hooks/useParts'
import { useSales } from './hooks/useSales'
import { sb } from './lib/supabase'
import { C, S, APP_VERSION, rentPerDay } from './lib/constants'
import { MARKETPLACE_LIST, guessMarketplace, setActiveMarketplace } from './lib/marketplaces'
import { planState } from './lib/plan'
import { DEFAULT_LABELS } from './lib/labels'
import AuthScreen from './components/AuthScreen'
import Dashboard from './components/Dashboard'
import Inventory from './components/Inventory'
import Settings from './components/Settings'
import SystemAdmin from './components/SystemAdmin'
import JoinStore from './components/JoinStore'
import Insights from './components/Insights'
import Vehicles from './components/Vehicles'
import Sales from './components/Sales'
import Ebay from './components/Ebay'

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'sales', label: 'Sales', icon: '🧾' },
  { id: 'inventory', label: 'Inventory', icon: '📦' },
  { id: 'ebay', label: 'eBay', icon: '🛒' },
  { id: 'insights', label: 'Insights', icon: '📈' },
  { id: 'vehicles', label: 'Vehicles', icon: '🚗' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
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
      await sb.from('stores').update({ settings: { marketplace: newMarketplace, ...(tz ? { timezone: tz } : {}) } }).eq('id', data)
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
          <div onClick={() => { setOpen(false); setCreating(false) }} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
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
                  <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createStore()}
                    placeholder="New store name" style={{ flex: 1, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none' }} />
                  <button onClick={createStore} disabled={busy || !newName.trim()}
                    style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (busy || !newName.trim()) ? 0.6 : 1 }}>{busy ? '…' : 'Create'}</button>
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
                  <input autoFocus value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && joinStore()}
                    placeholder="Join code" style={{ flex: 1, border: `1.5px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'monospace', fontWeight: 700, letterSpacing: 1 }} />
                  <button onClick={joinStore} disabled={busy || !joinCode.trim()}
                    style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (busy || !joinCode.trim()) ? 0.6 : 1 }}>{busy ? '…' : 'Join'}</button>
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

export default function App() {
  const { session, profile, storeId, stores, activeStoreId, setActiveStore, refreshStores, authReady, signOut } = useAuth()
  const { parts, loading, syncStatus, totalCount, addPart, editPart, softDelete, softDeleteCar, refetch } = useParts(storeId)
  const { sales } = useSales(storeId)
  const [tab, setTab] = useState('dashboard')
  const [toast, setToast] = useState(null)
  const lastFetchRef = useRef(Date.now())
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
  const [labels, setLabels] = useState(DEFAULT_LABELS)
  const [insightsInit, setInsightsInit] = useState(null) // drill-down filter from Dashboard
  const [cars, setCars] = useState([])
  const [marketplaceId, setMarketplaceId] = useState('EBAY_AU') // re-render trigger for currency
  const [plan, setPlan] = useState(() => planState(null)) // store's subscription plan (defaults open)
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false) // superadmin → System tab

  // One-time platform-admin check (drives the System tab visibility).
  useEffect(() => { sb.rpc('is_platform_admin').then(({ data }) => setIsPlatformAdmin(!!data)) }, [session])

  // Enrich costing with the storage-facility config (rent normalised to /day) and
  // the per-category shipping box dims, so partEffectiveCost can compute storage.
  const costingFull = useMemo(() => ({
    ...costing,
    shipping: shipping || undefined,
    storage: { volumeM3: +storage.volumeM3 || 0, rentPerDay: rentPerDay(storage.rent, storage.rentPeriod), usablePct: +storage.usablePct || 0 },
  }), [costing, shipping, storage])

  // Jump to Insights pre-filtered (e.g. clicking an aged-stock bracket).
  const drillToInsights = (init) => { setInsightsInit({ ...init, _ts: Date.now() }); setTab('insights') }

  // Name this window so the field app's "Open Admin" link returns to this tab
  useEffect(() => { window.name = 'partvault-admin' }, [])

  // Load store settings and cars on mount / when the active store changes
  useEffect(() => {
    if (!storeId) return
    // Reset to defaults so a previous store's settings don't bleed into this one
    setAiSettings(DEFAULT_AI_SETTINGS)
    setFooter(DEFAULT_FOOTER)
    setShipping(null)
    setCars([])
    // Load AI settings + footer
    sb.from('stores').select('settings, plan').eq('id', storeId).single().then(({ data }) => {
      setPlan(planState(data?.plan))
      if (data?.settings?.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
      if (data?.settings?.footer) setFooter(data.settings.footer)
      if (data?.settings?.costing) setCosting(s => ({ ...s, ...data.settings.costing }))
      if (data?.settings?.inventory) setInventory(s => ({ ...s, ...data.settings.inventory }))
      if (data?.settings?.storage) setStorage(s => ({ ...s, ...data.settings.storage }))
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
      .then(({ data }) => setCars(data || []))
  }, [storeId])

  const showToast = (msg, color = C.green) => { setToast({ msg, color }); setTimeout(() => setToast(null), 2500) }
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

  return (
    <div style={S.app}>
      <nav style={S.nav}>
        <div style={S.logo}>⚙ PartVault Admin</div>
        <StoreSwitcher stores={stores} activeStoreId={activeStoreId} setActiveStore={setActiveStore} refreshStores={refreshStores} />
        {(isPlatformAdmin ? [...TABS, { id: 'system', label: 'System', icon: '🛠️' }] : TABS).map(t => {
          // Analytics tabs (Insights/Vehicles) are Pro+ — Basic sees them locked.
          const gated = (t.id === 'insights' || t.id === 'vehicles') && !plan.can('analytics')
          return (
            <button key={t.id} style={{ ...S.navBtn(tab === t.id), opacity: gated ? 0.45 : 1 }}
              onClick={() => gated ? alert(`${t.label} is part of the Pro plan. Upgrade to unlock analytics.`) : setTab(t.id)}>
              {t.icon} {t.label}{gated ? ' 🔒' : ''}
            </button>
          )
        })}
        <div style={{ marginLeft: 'auto', padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>
          {loading ? <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> : null}
          v{APP_VERSION} · {totalCount} parts
          <SyncBadge status={syncStatus} />
          <a href="https://app.partvault.app" target="partvault-app" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>📱 Field App ↗</a>
          <button style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={refetch}>↻ Refresh</button>
          <button style={{ background: 'rgba(220,38,38,0.2)', border: '1px solid rgba(220,38,38,0.3)', color: 'rgba(255,255,255,0.7)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12 }} onClick={signOut}>Sign Out</button>
        </div>
      </nav>
      {plan.tier === 'trial' && !plan.expired && (
        <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '8px 24px', fontSize: 13, color: '#1d4ed8', fontWeight: 600 }}>
          ✨ Free trial — {Math.max(plan.trialDaysLeft ?? 0, 0)} day{(plan.trialDaysLeft ?? 0) === 1 ? '' : 's'} left with full access. Pick a plan before it ends to keep going without interruption.
        </div>
      )}
      {plan.expired && (
        <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '8px 24px', fontSize: 13, color: '#b91c1c', fontWeight: 600 }}>
          ⏰ Your free trial has ended. Your data is safe — choose a plan to keep capturing and listing parts.
        </div>
      )}
      <main style={S.main} key={marketplaceId}>{/* re-mounts content when the active store's currency changes */}
        {tab === 'dashboard' && <Dashboard parts={parts} sales={sales} costing={costingFull} inventory={inventory} onDrill={drillToInsights} onSeeSales={() => setTab('sales')} />}
        {tab === 'sales' && <Sales sales={sales} parts={parts} costing={costingFull} />}
        {tab === 'inventory' && (
          <Inventory
            parts={parts} cars={cars} storeId={storeId}
            onAdd={handleAdd} onEdit={handleEdit} onDelete={handleDel}
            onDeleteCar={softDeleteCar} onAddCar={handleAddCar}
            aiSettings={aiSettings} footer={footer} costing={costingFull} labels={labels}
          />
        )}
        {tab === 'ebay' && <Ebay storeId={storeId} onChanged={smartRefetch} />}
        {tab === 'insights' && <Insights storeId={storeId} initial={insightsInit} />}
        {tab === 'vehicles' && <Vehicles parts={parts} cars={cars} sales={sales} costing={costingFull} onRefresh={refetch} />}
        {tab === 'settings' && <Settings profile={profile} storeId={storeId} onSignOut={signOut} refreshStores={refreshStores}
          onSettingsSaved={s => { if (s?.costing) setCosting(c => ({ ...c, ...s.costing })); if (s?.inventory) setInventory(i => ({ ...i, ...s.inventory })); if (s?.storage) setStorage(st => ({ ...st, ...s.storage })); if (s?.shipping) setShipping(s.shipping); if (s?.labels) setLabels(l => ({ ...l, ...s.labels })) }} />}
        {tab === 'system' && isPlatformAdmin && <SystemAdmin />}
      </main>
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: toast.color, color: '#fff', padding: '12px 22px', borderRadius: 10, fontSize: 14, fontWeight: 600, zIndex: 1000, boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
