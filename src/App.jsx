import { useState, useEffect } from 'react'
import { useAuth } from './hooks/useAuth'
import { useParts } from './hooks/useParts'
import { sb } from './lib/supabase'
import { C, S, APP_VERSION } from './lib/constants'
import AuthScreen from './components/AuthScreen'
import Dashboard from './components/Dashboard'
import Inventory from './components/Inventory'
import CSVHistory from './components/CSVHistory'
import Settings from './components/Settings'

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'inventory', label: 'Inventory', icon: '📦' },
  { id: 'csv', label: 'CSV History', icon: '📄' },
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

export default function App() {
  const { session, profile, storeId, authReady, signOut } = useAuth()
  const { parts, loading, syncStatus, totalCount, addPart, editPart, softDelete, softDeleteCar, refetch } = useParts()
  const [tab, setTab] = useState('dashboard')
  const [toast, setToast] = useState(null)
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS)
  const [footer, setFooter] = useState(DEFAULT_FOOTER)
  const [cars, setCars] = useState([])

  // Load store settings and cars on mount
  useEffect(() => {
    if (!storeId) return
    // Load AI settings + footer
    sb.from('stores').select('settings').eq('id', storeId).single().then(({ data }) => {
      if (data?.settings?.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
      if (data?.settings?.footer) setFooter(data.settings.footer)
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

  return (
    <div style={S.app}>
      <nav style={S.nav}>
        <div style={S.logo}>⚙ PartVault Admin</div>
        {TABS.map(t => (
          <button key={t.id} style={S.navBtn(tab === t.id)} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>
          {loading ? <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span> : null}
          v{APP_VERSION} · {totalCount} parts
          <SyncBadge status={syncStatus} />
          <button style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.9)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={refetch}>↻ Refresh</button>
          <button style={{ background: 'rgba(220,38,38,0.2)', border: '1px solid rgba(220,38,38,0.3)', color: 'rgba(255,255,255,0.7)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12 }} onClick={signOut}>Sign Out</button>
        </div>
      </nav>
      <main style={S.main}>
        {tab === 'dashboard' && <Dashboard parts={parts} />}
        {tab === 'inventory' && (
          <Inventory
            parts={parts} cars={cars} storeId={storeId}
            onAdd={handleAdd} onEdit={handleEdit} onDelete={handleDel}
            onDeleteCar={softDeleteCar} onAddCar={handleAddCar}
            aiSettings={aiSettings} footer={footer}
          />
        )}
        {tab === 'csv' && <CSVHistory storeId={storeId} />}
        {tab === 'settings' && <Settings profile={profile} storeId={storeId} onSignOut={signOut} />}
      </main>
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: toast.color, color: '#fff', padding: '12px 22px', borderRadius: 10, fontSize: 14, fontWeight: 600, zIndex: 1000, boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
