// Taxonomy helpers for the eBay import — plain JS so the Node tests import the
// SAME code the edge function runs (tests/category-map.test.mjs). Pure: no Deno,
// no network, no database.
export const SUB_LISTS = {
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
// KEEP IN STEP with EBAY_AU_CATEGORIES in src/lib/constants.js — tests/category-map.test.mjs fails if they drift.

export const normName = (s) => String(s || '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .split(' ').map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ')

// eBay's leaf name → our subcategory, when one clearly corresponds.
export function matchSubcategory(friendly, leafName) {
  const list = SUB_LISTS[friendly] || []
  const leaf = normName(leafName)
  if (!leaf) return ''
  for (const s of list) if (normName(s) === leaf) return s
  // Ours may be a longer label for the same thing — eBay "Headlights" is our
  // "Headlight Assemblies" — so accept OUR name containing theirs.
  //
  // Deliberately NOT the other direction: eBay "Tail Light Lenses" contains our
  // "Tail Lights", but a lens is not a tail light. Matching that way files
  // distinct sub-parts under the wrong heading (and "Brake Pad Wear Sensors"
  // under "Brake Pads"), so those keep eBay's own, more specific name instead.
  const near = list
    .filter(s => s !== 'Other')
    .filter(s => normName(s).includes(leaf))
    .sort((a, b) => a.length - b.length)
  if (near.length) return near[0]
  return leafName            // eBay's own name beats flattening it to "Other"
}

// Flatten a taxonomy subtree into lookup rows.
export function flattenSubtree(node, friendly, rootId, out, mp) {
  const cat = node?.category
  if (cat?.categoryId) {
    out.push({
      marketplace: mp,
      category_id: String(cat.categoryId),
      friendly_category: friendly,
      leaf_name: cat.categoryName || null,
      subcategory: matchSubcategory(friendly, cat.categoryName || '') || null,
      root_id: rootId,
      updated_at: new Date().toISOString(),
    })
  }
  for (const child of (node?.childCategoryTreeNodes || [])) flattenSubtree(child, friendly, rootId, out, mp)
}
