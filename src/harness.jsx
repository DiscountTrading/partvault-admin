// DEV-ONLY layout harness. Not part of the production build (vite.config lists
// only index.html + ops.html as inputs) — it exists so a screen can be rendered
// with realistic mock data at any viewport WITHOUT a login or a live database,
// which is the only way to check the phone layouts of screens that normally sit
// behind auth. Open http://localhost:5173/harness.html?screen=inventory
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Inventory from './components/Inventory'
import Dashboard from './components/Dashboard'
import Sales from './components/Sales'
import Analytics from './components/Analytics'
import Settings from './components/Settings'
import Vehicles from './components/Vehicles'
import BulkEdit from './components/BulkEdit'
import PartForm from './components/PartForm'
import Help from './components/Help'
import { C, S } from './lib/constants'
import { sb } from './lib/supabase'

const MAKES = [['Toyota','Corolla','2008'],['Ford','Ranger','2016'],['Holden','Commodore','2011']]
const CATS = [['Brakes & Brake Parts','Brake Pads'],['Lighting & Bulbs','Tail Lights'],['Engines & Engine Parts','Cylinder Heads'],['Exterior Parts','Door Mirrors']]
const STATUSES = ['in_stock','listed','sold','deferred']

const parts = Array.from({ length: 23 }, (_, i) => {
  const [make, model, year] = MAKES[i % 3]
  const [category, subcategory] = CATS[i % 4]
  const status = STATUSES[i % 4]
  return {
    id: `p${i}`, store_id: 'store-1', car_id: `car${i % 3}`,
    sku: `PV-${1000 + i}`,
    title: `${make} ${model} ${subcategory} ${i % 2 ? 'front right' : 'rear left'}`,
    partNumber: i % 3 ? `${89000 + i}-A` : '',
    make, model, year, category, subcategory,
    condition: i % 5 === 0 ? 'New' : 'Used - Good',
    status, list_price: 40 + i * 13, quantity: i % 7 === 0 ? 3 : 1, quantitySold: 0,
    ai_assessed: i % 3 !== 0,
    photos: i % 4 === 0 ? [] : [{ url: 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2280%22%20height%3D%2280%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20fill%3D%22%2523ccc%22%2F%3E%3C%2Fsvg%3E' }],
    primary_photo: i % 4 === 0 ? null : 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2280%22%20height%3D%2280%22%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20fill%3D%22%2523ccc%22%2F%3E%3C%2Fsvg%3E',
    costs: { purchase: 10 + i, postage: 0 },
    createdAt: new Date(Date.now() - i * 36e5).toISOString(),
    ebayItemId: status === 'listed' ? `1234567890${i}` : null,
    isSample: i === 5,
  }
})
const cars = MAKES.map(([make, model, year], i) => ({ id: `car${i}`, store_id: 'store-1', make, model, year, purchase_price: 1200 + i * 300 }))
const sales = parts.filter(p => p.status === 'sold').map((p, i) => ({
  id: `s${i}`, partId: p.id, sku: p.sku, title: p.title, quantity: 1,
  soldPrice: p.list_price, shipping: 12, fees: 8, refund: 0, discount: i % 3 === 0 ? 5 : 0,
  soldAt: new Date(Date.now() - i * 864e5).toISOString(), source: 'ebay', stage: 'paid',
}))
// The harness has no session, so the Supabase-backed screens would render empty.
// Stub ONLY the reads these screens make, in the harness file — the app itself
// stays free of test hooks.
const insightRows = parts.map((p, i) => ({
  part_id: p.id, store_id: 'store-1', sku: p.sku, title: p.title, status: p.status,
  make: p.make, model: p.model, part_number: p.partNumber, source: i % 5 === 0 ? 'ebay_import' : 'partvault',
  days_on_shelf: 5 + i * 11, listing_count: i % 3, total_days_listed: i * 4,
  total_cost: 20 + i, list_price: p.list_price, profit: p.list_price - (20 + i),
  margin_pct: Math.round(((p.list_price - (20 + i)) / p.list_price) * 100),
  market_price: 30 + i * 12, price_variance_pct: i % 2 ? 12 : -8,
  market_checked_at: new Date(Date.now() - i * 864e5).toISOString(),
  days_to_sell: p.status === 'sold' ? 10 + i : null, sold_at: p.status === 'sold' ? new Date().toISOString() : null,
}))
const STUBBED = { part_insights: insightRows, saved_views: [] }
const origFrom = sb.from.bind(sb)
sb.from = (table) => {
  if (!(table in STUBBED)) return origFrom(table)
  const rows = STUBBED[table]
  const b = {
    select: () => b, eq: () => b, order: () => b, range: () => b, limit: () => b,
    single: () => Promise.resolve({ data: rows[0] || null, error: null }),
    then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
  }
  return b
}

const costing = { costsEnabled: true, acquisitionBase: 300, labourPerPart: 12, adminPerPart: 3 }

const SCREENS = {
  inventory: () => <Inventory parts={parts} cars={cars} storeId="store-1" costing={costing}
    onAdd={async () => {}} onEdit={async () => {}} onDelete={() => {}} onDeleteCar={async () => {}} onAddCar={() => {}}
    aiSettings={{}} footer="" refetch={() => {}} assess={{}} />,
  dashboard: () => <Dashboard parts={parts} sales={sales} costing={costing} storeId="store-1" onDrill={() => {}} onSeeSales={() => {}} />,
  sales: () => <Sales sales={sales} parts={parts} costing={costing} />,
  analytics: () => <Analytics storeId="store-1" parts={parts} cars={cars} sales={sales} costing={costing} onVehiclesChanged={() => {}} />,
  partform: () => <PartForm part={parts[0]} cars={cars} storeId="store-1" costing={costing} aiSettings={{}} footer="" allParts={parts}
    onSave={async () => {}} onSaveAndAdd={async () => {}} onCancel={() => {}} />,
  bymodel: () => <Vehicles parts={parts} cars={cars} sales={sales} costing={costing} level="models" />,
  bycar: () => <Vehicles parts={parts} cars={cars} sales={sales} costing={costing} level="cars" />,
  bulkedit: () => <BulkEdit parts={parts} cars={cars} storeId="store-1" onClose={() => {}} onSaved={() => {}} />,
  help: () => <Help storeId="store-1" />,
  settings: () => <Settings profile={{ id: 'u1', email: 'demo@partvault.app' }} storeId="store-1" parts={parts}
    onSignOut={() => {}} refreshStores={() => {}} onSettingsSaved={() => {}} onChanged={() => {}} sync={{}} />,
}

const screen = new URLSearchParams(location.search).get('screen') || 'inventory'
const render = SCREENS[screen] || SCREENS.inventory

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div style={{ background: C.bg, color: C.text, minHeight: '100vh', paddingBottom: 90 }}>
      <div style={{ fontSize: 11, color: C.muted, padding: '10px 12px 0' }}>harness · {screen} · {window.innerWidth}px</div>
      {/* The app wraps every screen in S.main, which carries a maxWidth of 1600.
          The harness used its own padding and no cap, so it measured screens on a
          wider canvas than they ever get in the app — density numbers taken here
          came out flattering on any monitor wider than 1600px. Use the real one. */}
      <div style={S.main}>{render()}</div>
    </div>
  </StrictMode>
)
