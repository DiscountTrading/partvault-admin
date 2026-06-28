export const APP_VERSION = '3.20.1'

export const C = {
  bg:'#f5f4f0', panel:'#edeae3', card:'#ffffff', border:'#ddd9d0',
  accent:'#e8590c', blue:'#2563eb', green:'#16a34a',
  red:'#dc2626', yellow:'#b45309', text:'#1c1c1e', muted:'#6b7280',
  white:'#ffffff', headerBg:'#1c1c1e',
}

export const PART_CONDITIONS = ['Used – Excellent','Used – Good','Used – Fair','For Parts Only','Refurbished']
export const AU_SHIPPING = ['Standard Post','Express Post','Courier','Courier (Bulky)','Collect Only','Free Postage']
export const STATUS_COLORS = {in_stock:C.blue,listed:C.accent,sold:C.green,scrapped:C.muted,deferred:C.yellow}
export const STATUS_LABELS = {in_stock:'In Stock',listed:'Listed',sold:'Sold',scrapped:'Scrapped',deferred:'Deferred'}

export const EBAY_AU_CATEGORIES = {
  'Air & Fuel Delivery':['Air Filters','Carburettors & Parts','Fuel Filters','Fuel Injectors','Fuel Pumps','Intercoolers','Throttle Bodies','Turbochargers & Parts','Other'],
  'Air Conditioning & Heating':['A/C Compressors','A/C Condensers','Blower Motors','Evaporators','Heater Cores','Pollen Filters','Other'],
  'Brakes & Brake Parts':['Brake Disc Rotors','Brake Drums','Brake Pads','Brake Shoes','Calipers & Brackets','Master Cylinders','Brake Hoses','ABS Sensors','Other'],
  'Engines & Engine Parts':['Complete Engines','Cylinder Heads','Engine Mounts','Oil Pumps','Timing Belts & Kits','Valve Covers','Water Pumps','Other'],
  'Engine Cooling':['Radiators','Water Pumps','Thermostats','Cooling Fans','Oil Coolers','Other'],
  'Exhaust & Emission':['Catalytic Converters','DPF Filters','EGR Valves','Exhaust Manifolds','Mufflers','Exhaust Pipes','Other'],
  'Exterior Parts':['Bumper Bars','Door Mirrors','Door Panels','Fenders / Guards','Grilles','Bonnet / Hood','Boot Lid','Other'],
  'Ignition Systems':['Coil Packs','Glow Plugs','Ignition Coils','Spark Plugs','Distributor','Other'],
  'Interior Parts':['Dashboards','Door Cards','Instrument Clusters','Seats','Seat Belts','Steering Wheels','Window Regulators','Other'],
  'Lighting & Bulbs':['Headlight Assemblies','Tail Lights','Fog Lights','Indicators','Reverse Lights','Globes & Bulbs','Interior Lights','DRL','Other'],
  'Starters, Alternators & Wiring':['Alternators','ECUs','Fuse Boxes','Starter Motors','Wiring Looms','Other'],
  'Steering & Suspension':['Ball Joints','Coil Springs','Control Arms','Power Steering Pumps','Shock Absorbers','Tie Rod Ends','Wheel Bearings','Other'],
  'Transmission & Drivetrain':['Clutch Kits','CV Boots','Driveshafts','Gearboxes -- Auto','Gearboxes -- Manual','Transfer Cases','Other'],
  'Wheels, Tyres & Parts':['Tyres','Wheels -- Alloy','Wheels -- Steel','Wheel Nuts','Other'],
  'Towing Parts':['Tow Bars','Trailer Sockets','Other'],
  'Other Car & Truck Parts':['Other'],
  'Legacy Items':['Other'],
}
export const CATEGORY_NAMES = Object.keys(EBAY_AU_CATEGORIES)

// Stored category/subcategory values don't always exactly equal our canonical
// strings — the AI can return a punctuation variant ("Gearboxes - Auto" vs
// "Gearboxes -- Auto", "Fenders/Guards" vs "Fenders / Guards") and an exact-match
// dropdown then shows nothing. These resolve a stored value to the canonical one
// by ignoring case, punctuation and &/and, so the editor stays robust.
const catKey = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
export const canonicalCategory = (cat) => {
  if (!cat) return ''
  if (EBAY_AU_CATEGORIES[cat]) return cat
  const k = catKey(cat)
  return CATEGORY_NAMES.find(c => catKey(c) === k) || cat
}
export const canonicalSubcategory = (cat, sub) => {
  if (!sub) return ''
  const subs = EBAY_AU_CATEGORIES[canonicalCategory(cat)] || []
  if (subs.includes(sub)) return sub
  const k = catKey(sub)
  return subs.find(s => catKey(s) === k) || sub
}
export const EBAY_AU_CATEGORY_IDS = {
  'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
  'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
  'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
  'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
  'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
  'Other Car & Truck Parts':'9886',
}

export const S = {
  app:{ minHeight:'100vh', background:C.bg, color:C.text },
  nav:{ background:C.headerBg, borderBottom:'1px solid rgba(0,0,0,0.12)', display:'flex', alignItems:'center', position:'sticky', top:0, zIndex:100, flexWrap:'wrap' },
  logo:{ color:'#fff', fontWeight:800, fontSize:20, fontFamily:"'Inter Tight',system-ui,sans-serif", padding:'14px 24px 14px 20px', borderRight:'1px solid rgba(255,255,255,0.12)', whiteSpace:'nowrap', letterSpacing:'-0.5px' },
  navBtn: a => ({ background:a?C.accent:'transparent', color:a?'#fff':'rgba(255,255,255,0.6)', border:'none', cursor:'pointer', padding:'14px 16px', fontSize:13, fontWeight:a?600:400, transition:'all .15s' }),
  main:{ padding:'28px 32px', maxWidth:1600, margin:'0 auto' },
  card:{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:24, boxShadow:'0 1px 3px rgba(0,0,0,0.06)' },
  label:{ fontSize:12, color:C.muted, fontWeight:600, marginBottom:6, display:'block', letterSpacing:'0.2px' },
  input:{ width:'100%', background:'#fff', border:`1.5px solid ${C.border}`, borderRadius:8, padding:'10px 14px', color:C.text, fontSize:14, boxSizing:'border-box', outline:'none' },
  select:{ width:'100%', background:'#fff', border:`1.5px solid ${C.border}`, borderRadius:8, padding:'10px 14px', color:C.text, fontSize:14, boxSizing:'border-box' },
  textarea:{ width:'100%', background:'#fff', border:`1.5px solid ${C.border}`, borderRadius:8, padding:'10px 14px', color:C.text, fontSize:14, boxSizing:'border-box', resize:'vertical', minHeight:90 },
  btn:(v='primary') => ({ background:v==='primary'?C.accent:v==='green'?C.green:v==='blue'?C.blue:v==='danger'?C.red:'#fff', color:v==='secondary'?C.text:'#fff', border:v==='secondary'?`1.5px solid ${C.border}`:'none', borderRadius:8, padding:'10px 20px', fontSize:13, cursor:'pointer', fontWeight:600 }),
  pill: col => ({ background:col+'18', color:col, border:`1px solid ${col}33`, borderRadius:20, padding:'3px 10px', fontSize:12, fontWeight:600, display:'inline-block' }),
  h1:{ fontSize:24, fontWeight:700, fontFamily:"'Inter Tight',system-ui,sans-serif", margin:'0 0 4px', color:C.text },
  h2:{ fontSize:16, fontWeight:600, margin:'0 0 18px', color:C.text },
  statVal:{ fontSize:32, fontWeight:800, fontFamily:"'Inter Tight',system-ui,sans-serif", color:C.accent, margin:'6px 0 2px' },
  statLbl:{ fontSize:12, color:C.muted, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.5px' },
}

export const fmt = n => `$${(+n||0).toFixed(0)}`
export const pct = n => `${(+n||0).toFixed(1)}%`
export const today = () => new Date().toISOString().split('T')[0]
export const totalCost = p => Object.values(p.costs||{}).reduce((a,v)=>a+(+v||0),0)
export const partProfit = p => (+p.list_price||0) - totalCost(p)

// Default Australia Post-ish parcel rate table (grams → AUD). Editable per store
// in Settings → Costing. Used to estimate a postage *cost* when no actual carrier
// cost has been recorded — critical for "free shipping" sales where eBay reports
// $0 shipping income but the postage still cost us real money.
export const DEFAULT_POSTAGE_TIERS = [
  { maxG: 500,   cost: 10.30 },
  { maxG: 1000,  cost: 13.40 },
  { maxG: 3000,  cost: 16.55 },
  { maxG: 5000,  cost: 19.90 },
  { maxG: 22000, cost: 29.40 },
]
export const DEFAULT_HANDLING_FEE = 2      // fixed packing/handling labour per parcel ($)
export const DEFAULT_POSTAGE_WEIGHT_G = 1000 // assumed weight when a part has none

// Estimated postage cost for a part = carrier rate (by weight) + fixed handling.
//  - carrier: first tier whose maxG >= the part's weight; falls back to the
//    heaviest tier if over the table.
//  - handling: a flat per-parcel packing/handling cost (costing.handlingFee).
// Weight is in grams (part.weight); when unknown we assume costing.postageDefaultG.
export const estimatePostage = (p = {}, costing = {}) => {
  const tiers = (costing.postageTiers && costing.postageTiers.length ? costing.postageTiers : DEFAULT_POSTAGE_TIERS)
    .map(t => ({ maxG: +t.maxG || 0, cost: +t.cost || 0 }))
    .sort((a, b) => a.maxG - b.maxG)
  const handling = costing.handlingFee === '' || costing.handlingFee == null ? DEFAULT_HANDLING_FEE : +costing.handlingFee || 0
  const weightG = +p.weight > 0 ? +p.weight : (+costing.postageDefaultG || DEFAULT_POSTAGE_WEIGHT_G)
  const tier = tiers.find(t => weightG <= t.maxG) || tiers[tiers.length - 1] || { cost: 0 }
  const carrier = +tier.cost || 0
  return { carrier, handling, total: carrier + handling, weightG }
}

// The postage cost we use for a part: the actual recorded carrier cost
// (costs.postage) if present, otherwise the weight-based estimate. `estimated`
// flags which one was used so the UI can show it's a projection.
export const postageCostFor = (p = {}, costing = {}) => {
  const actual = +(p.costs?.postage) || 0
  if (actual > 0) return { value: actual, estimated: false }
  return { value: estimatePostage(p, costing).total, estimated: true }
}

export const DEFAULT_BASE_COST_PCT = 25 // fallback part cost as % of sale price

// Aged-stock reporting. agedThresholdDays = when a still-unsold part is "aged".
// ageBrackets = ascending day boundaries used to bucket aged stock for the chart;
// an implicit "older" bucket catches anything beyond the last boundary.
export const DEFAULT_AGED_THRESHOLD_DAYS = 60
export const DEFAULT_AGE_BRACKETS = [90, 180, 365, 730, 1065]

// Bucket parts into age brackets. Returns [{ label, min, max, count, value }]
// where max=null is the open-ended "older" bucket. `ageOf` returns a part's age
// in days (or null); `valueOf` returns the $ to total per bucket.
export const bucketByAge = (parts, brackets = DEFAULT_AGE_BRACKETS, ageOf, valueOf = () => 0) => {
  const bounds = [...brackets].map(Number).filter(n => n > 0).sort((a, b) => a - b)
  const buckets = []
  let prev = 0
  for (const b of bounds) { buckets.push({ label: `${prev}–${b}d`, min: prev, max: b, count: 0, value: 0 }); prev = b }
  buckets.push({ label: `${prev}d+`, min: prev, max: null, count: 0, value: 0 })
  for (const p of parts) {
    const d = ageOf(p)
    if (d == null) continue
    const bk = buckets.find(x => x.max == null ? d >= x.min : (d >= x.min && d < x.max))
    if (bk) { bk.count++; bk.value += +valueOf(p) || 0 }
  }
  return buckets
}

// Estimated cost basis for a part, from the store costing config:
//  - carShare: the car's purchase price spread across its parts, proportional
//    to each part's sale price (re-divides as more parts are added).
//  - baseCost: fallback part-acquisition cost (% of sale price) used ONLY when we
//    have no other acquisition signal — no linked car and no manual acquisition
//    cost. Gives disorganised businesses a sensible cost base to start from.
//  - labour: 'fixed' mode = removal_minutes/60 * hourly rate; 'percent' = % of sale.
//  - admin: max(base, floor) where base & floor are each % of sale or a fixed $,
//    per adminMode / adminMinMode.
//  - postage: actual carrier cost if recorded, else weight-based estimate + handling.
// `carPartsValue` is the sum of list prices of all (non-deleted) parts for the
// same car; `carPrice` is that car's purchase price.
export const estimateCostBasis = (p, costing = {}, carPrice = 0, carPartsValue = 0) => {
  const price = +p.list_price || +p.listPrice || 0
  const labourRate = +costing.labourRate || 0
  const adminPct = +costing.adminPct || 0
  const adminMin = +costing.adminMin || 0
  const carShare = (carPrice > 0 && carPartsValue > 0) ? carPrice * (price / carPartsValue) : 0
  const manualAcq = +p.costs?.acquisition || 0
  const baseCostVal = costing.baseCostPct == null || costing.baseCostPct === '' ? DEFAULT_BASE_COST_PCT : +costing.baseCostPct || 0
  // Base cost only applies when there's no other acquisition signal; it's either a
  // % of sale price or a fixed $ per part (costing.baseCostMode).
  const baseCost = (carShare === 0 && manualAcq === 0 && baseCostVal > 0)
    ? (costing.baseCostMode === 'fixed' ? baseCostVal : price * baseCostVal / 100)
    : 0
  // Each of labour / admin / admin-minimum can be a % of sale price or a fixed $.
  const labour = (costing.labourMode === 'percent')
    ? price * labourRate / 100
    : (+p.removalMinutes || +p.removal_minutes || 0) / 60 * labourRate
  const adminBase  = (costing.adminMode === 'fixed')    ? adminPct : price * adminPct / 100
  const adminFloor = (costing.adminMinMode === 'percent') ? price * adminMin / 100 : adminMin
  const admin = Math.max(adminBase, adminFloor)
  const post = postageCostFor(p, costing)
  return { carShare, baseCost, labour, admin, postage: post.value, postageEstimated: post.estimated, total: carShare + baseCost + labour + admin + post.value }
}

// ── Warehouse storage cost ──────────────────────────────────────────────────
// Turn a warehouse's rent + usable volume into a per-part storage cost. The rent
// is amortised over only the USABLE storage volume (the air/working space you pay
// for but can't store sellable stock in is carried by the stock that sells). A
// part's volume comes from its category package box (Shipping settings, cm), and
// the cost accrues over the time it's held — so slow movers cost more.
export const RENT_PERIOD_DAYS = { weekly: 7, monthly: 30.44, annual: 365 }
export const rentPerDay = (rent, period) => (+rent || 0) / (RENT_PERIOD_DAYS[period] || RENT_PERIOD_DAYS.monthly)

const partBoxVolumeM3 = (p, costing = {}) => {
  const ship = costing.shipping || {}
  const box = (ship.cats && ship.cats[canonicalCategory(p.category)]) || ship.default || {}
  const l = +box.l, w = +box.w, h = +box.h
  if (!(l > 0 && w > 0 && h > 0)) return 0
  return (l * w * h) / 1e6 // cm³ → m³
}
const daysHeld = (p) => {
  const start = p.acquiredDate || p.acquired_date || p.createdAt || p.created_at
  if (!start) return 0
  const end = p.soldDate || p.sold_date || null
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  return ms > 0 ? ms / 86400000 : 0
}
// Storage cost incurred by a part to date (or until sold). 0 unless a storage
// facility is configured AND the part's category has box dimensions.
export const storageCostFor = (p = {}, costing = {}) => {
  const st = costing.storage
  if (!st || !(+st.volumeM3 > 0) || !(+st.rentPerDay > 0) || !(+st.usablePct > 0)) return { value: 0, estimated: false }
  const usableVol = (+st.volumeM3) * (+st.usablePct) / 100
  const vol = partBoxVolumeM3(p, costing)
  if (usableVol <= 0 || vol <= 0) return { value: 0, estimated: false }
  const ratePerM3PerDay = (+st.rentPerDay) / usableVol
  return { value: ratePerM3PerDay * vol * daysHeld(p), estimated: true }
}
export const storageConfigured = (costing = {}) =>
  !!(costing.storage && +costing.storage.volumeM3 > 0 && +costing.storage.rentPerDay > 0 && +costing.storage.usablePct > 0)

// Best single cost figure for a part, for roll-ups (Dashboard / Insights).
// Additive: recorded costs (acquisition, postage, eBay fees, …) PLUS the estimated
// components not already captured (base cost when no acquisition, removal labour,
// admin, and a postage estimate when none recorded). This way real eBay fees are
// counted on top of the cost estimate rather than replacing it. `estimated` flags
// whether any of the figure is a projection. When a storage facility is set, the
// computed storage cost replaces the flat recorded `storage` figure.
export const partEffectiveCost = (p = {}, costing = {}) => {
  const sc = storageCostFor(p, costing)
  const useStorage = storageConfigured(costing)
  const recorded = totalCost(p) - (useStorage ? (+p.costs?.storage || 0) : 0)
  const manualPost = +(p.costs?.postage) || 0
  const b = estimateCostBasis(p, costing, 0, 0) // baseCost (gated on no acquisition), labour, admin, postage
  const supplement = b.baseCost + b.labour + b.admin + (manualPost > 0 ? 0 : b.postage) + sc.value
  return { value: recorded + supplement, estimated: supplement > 0 }
}
