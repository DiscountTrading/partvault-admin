export const APP_VERSION = '2.3.2.6'

export const C = {
  bg:'#f5f4f0', panel:'#edeae3', card:'#ffffff', border:'#ddd9d0',
  accent:'#e8590c', blue:'#2563eb', green:'#16a34a',
  red:'#dc2626', yellow:'#b45309', text:'#1c1c1e', muted:'#6b7280',
  white:'#ffffff', headerBg:'#1c1c1e',
}

export const PART_CONDITIONS = ['Used – Excellent','Used – Good','Used – Fair','For Parts Only','Refurbished']
export const AU_SHIPPING = ['Standard Post','Express Post','Courier','Courier (Bulky)','Collect Only','Free Postage']
export const STATUS_COLORS = {'In Stock':C.blue,'Listed':C.accent,'Sold':C.green,'Archived':C.muted,'Deleted':C.red}

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
  'Lighting & Bulbs':['Headlight Assemblies','Tail Lights','Fog Lights','Indicators','DRL','Other'],
  'Starters, Alternators & Wiring':['Alternators','ECUs','Fuse Boxes','Starter Motors','Wiring Looms','Other'],
  'Steering & Suspension':['Ball Joints','Coil Springs','Control Arms','Power Steering Pumps','Shock Absorbers','Tie Rod Ends','Wheel Bearings','Other'],
  'Transmission & Drivetrain':['Clutch Kits','CV Boots','Driveshafts','Gearboxes -- Auto','Gearboxes -- Manual','Transfer Cases','Other'],
  'Wheels, Tyres & Parts':['Tyres','Wheels -- Alloy','Wheels -- Steel','Wheel Nuts','Other'],
  'Towing Parts':['Tow Bars','Trailer Sockets','Other'],
  'Other Car & Truck Parts':['Other'],
}
export const CATEGORY_NAMES = Object.keys(EBAY_AU_CATEGORIES)
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
