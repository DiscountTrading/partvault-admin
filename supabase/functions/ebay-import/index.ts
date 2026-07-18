import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROXY                   = 'https://partvault-proxy.leap00.workers.dev'
// eBay developer keyset — a single application identity shared by every store.
// These are platform-level config, NOT per-store data. Set them as edge-function
// secrets (Supabase dashboard → Edge Functions → Secrets). Fallbacks keep the
// existing app working if the secrets are not yet set; CERT_ID has no fallback
// because it is a client secret and must never be hard-coded.
const APP_ID                  = Deno.env.get('EBAY_APP_ID')  || 'Discount-PartVaul-PRD-36c135696-64f7f7bf'
const CERT_ID                 = Deno.env.get('EBAY_CERT_ID') || ''
const RUNAME                  = Deno.env.get('EBAY_RUNAME')  || 'Discount_Tradin-Discount-PartVa-jhtznvhgx'
const EDGE_FN_VERSION         = '3.36.20'

// ═══════════════════════════════════════════════════════════════════════════
//  HARD BLOCK — EDITING LIVE eBay LISTINGS IS DISABLED AT THE CODE LEVEL.
//
//  Requested by the store owner (2026-07-14). Rationale: a wrong write to a live
//  listing — above all a SKU/custom label — makes parts unfindable in the
//  warehouse. That is unrecoverable in practice, so the capability is removed
//  rather than guarded by a confirmation dialog.
//
//  While false:
//    • apply_specifics NEVER pushes to eBay (local overrides only).
//    • publish_listings REFUSES any part that already has a live listing —
//      no inventory-item replace, no offer update, no compatibility write.
//    • Creating a listing for a part that is NOT live is still allowed.
//
//  DO NOT flip this to true without explicit written sign-off from the owner.
//  Any future live-edit feature must be per-item, explicitly confirmed, never
//  bulk, and must never send a SKU.
// ═══════════════════════════════════════════════════════════════════════════
const ALLOW_LIVE_EBAY_EDITS = false
const CHUNK_SIZE              = 20
// eBay's getOrders can't return orders older than this, so the live sync only ever
// manages sales within this window. The CSV history import must stay strictly OLDER
// than this so it can never collide with (or be clobbered by) a future sync.
const API_WINDOW_DAYS        = 90
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const FUNCTION_TIMEOUT_MS     = 45 * 1000 // safety net; the chunk soft-limits at ~18s
const EBAY_TOKEN_URL          = 'https://api.ebay.com/identity/v1/oauth2/token'
const EBAY_SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.account.readonly'

// ── Vehicle title parser (server copy of src/lib/vehicles.js) ─────────────────
// Recovers make/model/year from an eBay title so the sync can fill them in itself.
// Keep in sync with the client copy if the lists change.
// Superset across marketplaces (AU + US/CA + UK makes) — safe for parsing any
// region's titles; the regional nuance lives in the alias sets below.
const MAKES = ['Toyota','Ford','Holden','Mazda','Hyundai','Kia','Mitsubishi','Nissan','Subaru','Honda','Volkswagen','BMW','Mercedes-Benz','Audi','Land Rover','Isuzu','Suzuki','Lexus','Jeep','Volvo','Renault','Peugeot','Citroen','Skoda','Fiat','Alfa Romeo','MINI','Porsche','Jaguar','Chrysler','Dodge','MG','LDV','GWM','Haval','Chery','SsangYong','Daihatsu','Proton','Tesla','Genesis','Saab','Chevrolet','GMC','RAM','Buick','Cadillac','Lincoln','Pontiac','Mercury','Oldsmobile','Saturn','Hummer','Acura','Infiniti','Scion','Vauxhall','Rover','SEAT','Dacia','Bentley','Aston Martin','Lotus','Rolls-Royce','Other']
const MODEL_SUGS: Record<string, string[]> = {
  Toyota:['Hilux','Camry','Corolla','RAV4','LandCruiser','LandCruiser 200','LandCruiser 79','Prado','HiAce','Kluger','Yaris','Aurion','C-HR','86','Fortuner','Tarago','Echo','Avensis','FJ Cruiser','Rukus','Supra','Granvia'],
  Ford:['Ranger','Falcon','Territory','Focus','Fiesta','Escape','Explorer','Mustang','Transit','Mondeo','Kuga','Everest','Endura','Puma','Ecosport','Courier','Laser','Fairmont','Fairlane','Festiva'],
  Holden:['Commodore','Colorado','Trax','Captiva','Cruze','Astra','Barina','Trailblazer','Calais','Caprice','Statesman','Crewman','Rodeo','Epica','Viva','Spark','Acadia','Equinox','Malibu','Ute','Berlina','Monaro'],
  Mazda:['CX-5','CX-3','CX-9','CX-7','CX-8','CX-30','Mazda2','Mazda3','Mazda6','BT-50','MX-5','RX-7','RX-8','121','323','626','Tribute','Premacy','Bravo'],
  Hyundai:['i30','Tucson','Santa Fe','i20','i40','Accent','Elantra','Sonata','ix35','Kona','Getz','Veloster','iLoad','iMax','Palisade','Venue','Staria','Terracan','Excel','Iload'],
  Kia:['Sportage','Cerato','Rio','Sorento','Carnival','Stinger','Seltos','Picanto','Soul','Spectra','Optima','Niro','EV6','Grand Carnival','Magentis'],
  Mitsubishi:['Triton','ASX','Outlander','Eclipse Cross','Pajero','Pajero Sport','Lancer','Mirage','Magna','Express','380','Challenger','Colt','Grandis','Verada','Outlander PHEV'],
  Nissan:['Navara','X-Trail','Patrol','Pathfinder','Qashqai','Pulsar','Skyline','Micra','Maxima','350Z','370Z','Murano','Juke','Dualis','Tiida','Almera','Cube','Leaf','Elgrand','Note','GT-R'],
  Subaru:['Forester','Outback','Impreza','Liberty','WRX','BRZ','XV','Tribeca','Levorg','Crosstrek','Exiga'],
  Honda:['CR-V','HR-V','Jazz','Civic','Accord','City','Odyssey','Legend','Integra','S2000','NSX','Insight','Accord Euro','CR-Z','MDX'],
  Volkswagen:['Golf','Polo','Tiguan','Passat','Amarok','Caddy','Transporter','Touareg','Jetta','Beetle','Multivan','Crafter','T-Cross','T-Roc','Up','Eos','Scirocco','Bora'],
  BMW:['1 Series','2 Series','3 Series','4 Series','5 Series','6 Series','7 Series','8 Series','X1','X2','X3','X4','X5','X6','X7','Z4','M3','M5','i3'],
  'Mercedes-Benz':['A-Class','B-Class','C-Class','E-Class','S-Class','CLA','CLS','GLA','GLB','GLC','GLE','GLS','ML','GL','Vito','Sprinter','V-Class','Valente','SLK','Viano'],
  Audi:['A1','A3','A4','A5','A6','A7','A8','Q2','Q3','Q5','Q7','Q8','TT','S3','RS3','S4','S5'],
  'Land Rover':['Discovery','Discovery Sport','Range Rover','Range Rover Sport','Range Rover Evoque','Range Rover Velar','Defender','Freelander'],
  Isuzu:['D-Max','MU-X','NPR','NLR','FRR'],
  Suzuki:['Swift','Vitara','Grand Vitara','Jimny','Baleno','Ignis','S-Cross','Alto','SX4','Liana','APV','Kizashi'],
  Lexus:['RX','NX','GX','IS','ES','LS','UX','LC','RC','CT','LX'],
  Jeep:['Wrangler','Cherokee','Grand Cherokee','Compass','Renegade','Patriot'],
  Volvo:['XC90','XC60','XC40','S60','S90','V40','V60','XC70','C30','S40','V50'],
  Renault:['Megane','Clio','Koleos','Trafic','Master','Captur','Kangoo','Scenic','Latitude'],
  Peugeot:['208','308','3008','2008','5008','partner','expert','boxer','207','206','307','4007','508'],
  Citroen:['C3','C4','C5','Berlingo','Dispatch','Relay','C4 Aircross'],
  Skoda:['Octavia','Fabia','Superb','Kodiaq','Karoq','Rapid','Yeti','Kamiq'],
  Fiat:['500','Ducato','Punto','Doblo','Scudo','Freemont'],
  'Alfa Romeo':['Giulietta','Giulia','Stelvio','159','Mito','147'],
  MINI:['Cooper','Countryman','Clubman','Paceman'],
  Porsche:['Cayenne','Macan','911','Panamera','Boxster','Cayman'],
  Jaguar:['XF','XE','XJ','F-Pace','E-Pace','F-Type','S-Type','X-Type'],
  Chrysler:['300C','300','Sebring','Grand Voyager','PT Cruiser'],
  Dodge:['Journey','Caliber','Nitro','Ram'],
  MG:['ZS','MG3','HS','MG6','GS','ZST','MG5'],
  LDV:['G10','T60','V80','Deliver 9','D90','G10+'],
  GWM:['Cannon','Ute','H6','Jolion','Steed','V200','X240'],
  Haval:['H6','H2','H9','Jolion'],
  Chery:['Tiggo','J11','J3','Omoda'],
  SsangYong:['Musso','Rexton','Korando','Actyon','Stavic'],
  Daihatsu:['Sirion','Terios','Charade','YRV','Cuore'],
  Proton:['Gen-2','Persona','Jumbuck','Satria'],
  Tesla:['Model 3','Model Y','Model S','Model X'],
  Genesis:['G70','G80','GV70','GV80'],
  Saab:['9-3','9-5'],
  Chevrolet:['Silverado','Camaro','Corvette','Malibu','Equinox','Tahoe','Suburban','Impala','Cruze','Traverse','Colorado','Blazer','Trailblazer','Sonic','Spark','Aveo','Express','S10','Bolt','Volt'],
  GMC:['Sierra','Yukon','Acadia','Terrain','Canyon','Savana','Envoy'],
  RAM:['1500','2500','3500','ProMaster'],
  Buick:['Enclave','Encore','LaCrosse','Regal','Verano'],
  Cadillac:['Escalade','CTS','ATS','XT5','SRX','DeVille','XTS'],
  Lincoln:['Navigator','MKX','MKZ','Town Car','Continental','Aviator'],
  Pontiac:['G6','G8','Grand Prix','Firebird','GTO','Vibe','Bonneville'],
  Mercury:['Grand Marquis','Milan','Mountaineer','Sable'],
  Oldsmobile:['Alero','Cutlass','Intrigue'],
  Saturn:['Ion','Vue','Outlook','Aura'],
  Hummer:['H1','H2','H3'],
  Acura:['MDX','RDX','TL','TSX','TLX','ILX','Integra','RSX','NSX'],
  Infiniti:['G35','G37','Q50','Q60','QX60','QX80','FX35','M35','EX35'],
  Scion:['tC','xB','xA','xD','FR-S','iQ'],
  Vauxhall:['Corsa','Astra','Vectra','Insignia','Zafira','Meriva','Mokka','Vivaro','Combo','Antara','Signum','Omega','Tigra','Grandland','Crossland','Adam','Agila','Cascada'],
  Rover:['25','45','75','200','400','600','800','Metro'],
  SEAT:['Ibiza','Leon','Alhambra','Ateca','Arona','Altea','Toledo','Mii'],
  Dacia:['Duster','Sandero','Logan','Jogger'],
  Bentley:['Continental','Bentayga','Flying Spur','Arnage'],
  'Aston Martin':['DB9','DB11','Vantage','DBX','Rapide'],
  Lotus:['Elise','Exige','Evora','Emira'],
  'Rolls-Royce':['Phantom','Ghost','Cullinan','Wraith'],
}
// Region-dependent aliases: the GM family (Chevrolet/Vauxhall/Holden rebadges)
// resolves differently per marketplace — the exact "Holden problem" in reverse.
const BASE_ALIASES: Record<string, string> = {
  vw:'Volkswagen', volkswagon:'Volkswagen', 'volks wagen':'Volkswagen',
  mercedes:'Mercedes-Benz', merc:'Mercedes-Benz', benz:'Mercedes-Benz', 'mercedes benz':'Mercedes-Benz', 'merc benz':'Mercedes-Benz',
  landrover:'Land Rover', 'range rover':'Land Rover', rangerover:'Land Rover',
  'great wall':'GWM', greatwall:'GWM', 'ssang yong':'SsangYong', alfa:'Alfa Romeo', alfaromeo:'Alfa Romeo', volvo:'Volvo',
  'rolls royce':'Rolls-Royce', rollsroyce:'Rolls-Royce', aston:'Aston Martin', astonmartin:'Aston Martin', seat:'SEAT',
}
const REGION_ALIASES: Record<string, Record<string, string>> = {
  EBAY_AU: { chevrolet:'Holden', chev:'Holden', chevy:'Holden', vauxhall:'Holden', hsv:'Holden' },
  EBAY_US: { chev:'Chevrolet', chevy:'Chevrolet', hsv:'Holden' },
  EBAY_CA: { chev:'Chevrolet', chevy:'Chevrolet', hsv:'Holden' },
  EBAY_GB: { chev:'Chevrolet', chevy:'Chevrolet', hsv:'Holden' },
}
const aliasesFor = (mp?: string) => ({ ...BASE_ALIASES, ...(REGION_ALIASES[mp || ''] || REGION_ALIASES.EBAY_AU) })
const SKIP_DIRECT = new Set(['MINI', 'RAM'])
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tokenRe = (tok: string) => new RegExp('\\b' + escapeRe(tok.toLowerCase())
  .replace(/[-\s]+/g, '[-\\s]?').replace(/([a-z])(\d)/g, '$1[-\\s]?$2').replace(/(\d)([a-z])/g, '$1[-\\s]?$2') + '\\b')
function parseYearRange(title = ''): string {
  let years = [...title.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)].map(m => +m[1])
  if (!years.length) years = [...title.matchAll(/\b\d{1,2}\/(\d{2})\b/g)].map(m => { const n = +m[1]; return n <= 49 ? 2000 + n : 1900 + n })
  if (!years.length) return ''
  const lo = Math.min(...years), hi = Math.max(...years)
  return lo === hi ? String(lo) : `${lo}-${hi}`
}
function parseVehicle(title = '', mp?: string): { make: string; model: string; year: string } {
  const t = (title || '').toLowerCase()
  const MAKE_ALIASES = aliasesFor(mp)
  let make = '', makeIdx = Infinity
  for (const mk of MAKES) { if (mk === 'Other' || SKIP_DIRECT.has(mk)) continue; const idx = t.search(tokenRe(mk)); if (idx >= 0 && idx < makeIdx) { make = mk; makeIdx = idx } }
  // Aliases win ties: for AU, "Chevrolet" resolves to Holden even though
  // Chevrolet is itself in the superset.
  for (const [alias, mk] of Object.entries(MAKE_ALIASES)) { const idx = t.search(tokenRe(alias)); if (idx >= 0 && idx <= makeIdx) { make = mk; makeIdx = idx } }
  let model = ''
  const matchModel = (mk: string) => { const cands = (MODEL_SUGS[mk] || []).slice().sort((a, b) => b.length - a.length); for (const md of cands) if (tokenRe(md).test(t)) return md; return '' }
  if (make) model = matchModel(make)
  if (!model) {
    const all = Object.entries(MODEL_SUGS).flatMap(([mk, ms]) => ms.map(md => [mk, md] as [string, string])).filter(([, md]) => md.length >= 3).sort((a, b) => b[1].length - a[1].length)
    for (const [mk, md] of all) { if (tokenRe(md).test(t)) { model = md; if (!make) make = mk; break } }
  }
  return { make, model, year: parseYearRange(title) }
}

const CATEGORY_ID_MAP: Record<string, string> = {
  '33549':'Air & Fuel Delivery','33542':'Air Conditioning & Heating',
  '33559':'Brakes & Brake Parts','33612':'Engines & Engine Parts',
  '33599':'Engine Cooling','33605':'Exhaust & Emission',
  '33637':'Exterior Parts','33687':'Ignition Systems',
  '33694':'Interior Parts','33707':'Lighting & Bulbs',
  '33572':'Starters, Alternators & Wiring','33579':'Steering & Suspension',
  '33726':'Transmission & Drivetrain','33743':'Wheels, Tyres & Parts',
  '180143':'Towing Parts','9886':'Other Car & Truck Parts',
  // Subcategories mapped to parent
  '50459':'Interior Parts','33705':'Interior Parts','33716':'Lighting & Bulbs',
  '33596':'Transmission & Drivetrain','262161':'Exterior Parts',
  '9887':'Other Car & Truck Parts','33712':'Lighting & Bulbs',
  '33648':'Exterior Parts','46102':'Interior Parts','61941':'Exterior Parts',
  '33706':'Interior Parts','33700':'Interior Parts','33545':'Interior Parts',
  '262085':'Brakes & Brake Parts','33557':'Air & Fuel Delivery',
  '33709':'Lighting & Bulbs','33566':'Brakes & Brake Parts',
  '262188':'Interior Parts','262221':'Starters, Alternators & Wiring',
  '33675':'Interior Parts','33558':'Air & Fuel Delivery',
  '262200':'Interior Parts','61304':'Engines & Engine Parts',
  '262183':'Ignition Systems','33546':'Air Conditioning & Heating',
  '173950':'Air & Fuel Delivery','183718':'Other Car & Truck Parts',
  '33704':'Interior Parts','39754':'Interior Parts',
}

// Build the eBay item specifics + confident fitment for a part, using the
// Taxonomy aspect list for its leaf category. Three passes: derive from our
// structured data, AI-fill the rest from the part photos, neutral fallback for
// required leftovers. Shared by publish_listings and preview_listing so the
// preview shows exactly what will be sent.
async function fillAspects(
  part: any,
  categoryId: string,
  categoryTreeId: string,
  ebayHeaders: Record<string, string>,
  aiPhotos: string[],
  listingDefaults: any = {},
): Promise<{ aspects: Record<string, string[]>; fitmentList: any[]; specs: any[] }> {
  const aspects: Record<string, string[]> = {}
  let fitmentList: any[] = []
  let specsOut: any[] = [] // full list of every aspect eBay offers for this category
  const titleLc = (part.title || '').toLowerCase()
  const placement = () => {
    const out: string[] = []
    if (/\bfront\b/.test(titleLc)) out.push('Front')
    if (/\b(rear|back)\b/.test(titleLc)) out.push('Rear')
    if (/\b(left|lh|l\/h|driver)\b/.test(titleLc)) out.push('Left')
    if (/\b(right|rh|r\/h|passenger)\b/.test(titleLc)) out.push('Right')
    return out.length ? out.join(', ') : null
  }
  const derive = (name: string): string | null => {
    const n = name.toLowerCase()
    // "Manufacturer Warranty" contains "manufacturer" but is a warranty PERIOD,
    // not the brand — never fill it with the make (handled separately below).
    if (/\b(brand|manufacturer)\b/.test(n) && !/part/.test(n) && !/warrant/.test(n)) return part.make || null
    if (/make/.test(n)) return part.make || null
    if (/model/.test(n)) return part.model || null
    if (/year/.test(n)) return part.year ? String(part.year) : null
    if (/(part\s*number|^mpn$|oe[\/\s]?oem|reference|interchange|supersed)/.test(n)) return part.part_number || null
    if (/placement/.test(n)) return placement()
    // NB: do NOT derive "Type" from our internal category — eBay's Type aspect
    // means the product type (e.g. "Headlight Bulb"), not our taxonomy. Let the
    // AI fill it from the photo instead.
    return null
  }
  try {
    const aRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`, { headers: ebayHeaders })
    if (aRes.ok) {
      const aData = await aRes.json()
      const NEUTRAL = ['unbranded', 'does not apply', 'unknown', 'not specified', 'unspecified', 'other', 'na', 'n/a']
      const specs = (aData.aspects || []).map((a: any) => ({
        name: a.localizedAspectName as string,
        required: !!a.aspectConstraint?.aspectRequired,
        selectionOnly: a.aspectConstraint?.aspectMode === 'SELECTION_ONLY',
        allowed: (a.aspectValues || []).map((v: any) => v.localizedValue).filter(Boolean) as string[],
      }))
      specsOut = specs
      const inAllowedOf = (allowed: string[], val: string) => allowed.find((v) => v.toLowerCase() === String(val).toLowerCase())

      // Pass 1 — fill from our own structured part/car data.
      for (const s of specs) {
        if (aspects[s.name]) continue
        const d = derive(s.name)
        if (!d) continue
        if (!s.selectionOnly || !s.allowed.length) aspects[s.name] = [d]
        else { const m = inAllowedOf(s.allowed, d); if (m) aspects[s.name] = [m] }
      }

      // Pass 2 — AI fills the remaining specifics + confident fitment from the photos.
      const todo = specs.filter((s: any) => !aspects[s.name]).slice(0, 30)
      const ANTHROPIC = Deno.env.get('ANTHROPIC_API_KEY')
      if (ANTHROPIC && aiPhotos.length && todo.length) {
        try {
          const aspList = todo.map((s: any) => s.selectionOnly && s.allowed.length
            ? `- ${s.name} (choose exactly one, verbatim: ${s.allowed.slice(0, 40).join(' | ')})`
            : `- ${s.name} (free text, max 60 chars)`).join('\n')
          const sys = `You are an expert Australian auto-parts eBay lister. Identify the part from the PHOTOS first — the provided Category is only a hint and may be wrong; trust the photos if they disagree. From the part photos and the known donor vehicle, do TWO things and return JSON only:\n{"aspects": {<aspectName>: <value>}, "fitment": [{"make":"","model":"","yearFrom":2012,"yearTo":2017,"trim":"","engine":""}]}\ntrim and engine are optional — include them only when the part is specific to that trim/engine; leave "" otherwise.\nASPECTS: fill in as MANY of the listed aspects as you reasonably can — do not leave fields blank when a sensible value is determinable. Use the photos, the identified part type, the donor vehicle, and standard knowledge of this kind of used auto part. Infer reasonable values for things like Type, Placement, Brand (the OEM make, or "Unbranded" for generic), Colour, Material, Surface Finish, Country/Region of Manufacture, and — for a clearly identified part — typical specs (e.g. the Voltage/Wattage/base size of a known bulb, the standard size of a known component). For "choose one" aspects return ONE listed option verbatim (pick the closest match), otherwise omit. Read any dimension, size, wattage, voltage, bulb base or part number that is PRINTED or visible in the photos and fill the matching aspect (Item Diameter, Item Length, Bulb Size, Voltage, Wattage, etc.). Do NOT fabricate a precise measurement, exact part number, or warranty term you cannot see or safely infer. Leave an aspect blank ONLY when you genuinely cannot determine a sensible value.\nFITMENT — list the vehicles this part actually fits (confidence is about whether it genuinely fits, NOT about how few you list):\n• VEHICLE-SPECIFIC parts (body panels, light assemblies, looms, ECUs, trim, mirrors): list only vehicles you are confident share the IDENTICAL part (same OEM/interchange number) — the donor vehicle plus platform-shared siblings you are sure about. Omit uncertain ones.\n• STANDARDISED / UNIVERSAL parts (a globe/bulb of a standard base such as H1/H4/H7/H11/HB3/9005, a fuse, a wiper blade of a given size, a standard spin-on oil filter, a common belt): these genuinely fit MANY vehicles. First identify the exact specification, then list the common Australian-market vehicles that use that spec — up to 20 popular models with realistic year ranges. This is accurate, not guessing, so do NOT restrict it to just the donor car.\nNever list a vehicle that does not actually take this part. Return an empty array only if you truly cannot tell.`
          const usr = `Part: ${part.title || ''}\nVehicle: ${part.make || ''} ${part.model || ''} ${part.year || ''}\nCategory: ${part.category || ''}\nPart number: ${part.part_number || 'unknown'}\n${aiPhotos.length > 1 ? `\nThe ${aiPhotos.length} photos are all of the SAME part from different angles/close-ups — use them together.` : ''}\nAspects to fill:\n${aspList}`
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6', max_tokens: 1400, system: sys,
              messages: [{ role: 'user', content: [
                ...aiPhotos.map((u: string) => ({ type: 'image', source: { type: 'url', url: u } })),
                { type: 'text', text: usr },
              ] }],
            }),
          })
          if (aiRes.ok) {
            const aiData = await aiRes.json()
            const raw = (aiData.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
            let map: any = null
            try { map = JSON.parse(raw) } catch { const mm = raw.match(/\{[\s\S]*\}/); if (mm) map = JSON.parse(mm[0]) }
            const aspMap = map?.aspects || map || {}
            for (const s of todo) {
              const v = aspMap[s.name]
              if (!v || typeof v !== 'string') continue
              if (s.selectionOnly && s.allowed.length) { const m = inAllowedOf(s.allowed, v); if (m) aspects[s.name] = [m] }
              else aspects[s.name] = [v.slice(0, 65)]
            }
            if (Array.isArray(map?.fitment)) fitmentList = map.fitment.slice(0, 50)
          }
        } catch (_) { /* AI is best-effort */ }
      }

      // Always include the donor vehicle in the fitment (the AI adds extra models
      // on top). Never let the donor car be dropped.
      if (part.make && part.model) {
        const dl = (s: any) => String(s || '').toLowerCase()
        const hasDonor = fitmentList.some((f: any) => dl(f.make) === dl(part.make) && dl(f.model) === dl(part.model))
        if (!hasDonor) {
          const ys = String(part.year || '').match(/\d{4}/g) || []
          fitmentList.unshift({ make: part.make, model: part.model, yearFrom: ys[0] ? +ys[0] : undefined, yearTo: ys[1] ? +ys[1] : (ys[0] ? +ys[0] : undefined), trim: '', engine: '' })
        }
      }

      // Compatible-vehicle item specifics (multi-value) from the fitment.
      if (fitmentList.length) {
        const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
        const makes = uniq(fitmentList.map((f: any) => f.make))
        const models = uniq(fitmentList.map((f: any) => f.model))
        const years = uniq(fitmentList.flatMap((f: any) => {
          const out: string[] = []; const yf = +f.yearFrom, yt = +f.yearTo || yf
          if (yf) for (let y = yf; y <= yt && y - yf < 40; y++) out.push(String(y))
          return out
        }))
        for (const s of specs) {
          const nlc = s.name.toLowerCase()
          if (!/compat/.test(nlc)) continue
          let vals = /make/.test(nlc) ? makes : /model/.test(nlc) ? models : /year/.test(nlc) ? years : []
          if (s.allowed.length) vals = vals.map((v) => inAllowedOf(s.allowed, v)).filter(Boolean) as string[]
          if (vals.length) aspects[s.name] = uniq([...(aspects[s.name] || []), ...vals]).slice(0, 30)
        }
      }

      // Pass 3 — required-but-empty → sensible/neutral value.
      for (const s of specs) {
        if (aspects[s.name] || !s.required) continue
        const nlc = s.name.toLowerCase()
        if (/\b(brand|manufacturer)\b/.test(nlc) && !/part/.test(nlc) && !/warrant/.test(nlc))
          aspects[s.name] = [s.allowed.length ? (inAllowedOf(s.allowed, 'Unbranded') || s.allowed[0]) : (part.make || 'Unbranded')]
        else if (/part\s*number|mpn/i.test(nlc)) aspects[s.name] = [part.part_number || 'Does Not Apply']
        else if (s.allowed.length) aspects[s.name] = [s.allowed.find((v: string) => NEUTRAL.includes(v.toLowerCase())) || s.allowed[0]]
        else aspects[s.name] = ['Unbranded']
      }

      // Warranty aspect(s) — a warranty PERIOD, set deterministically and never
      // derived from the make/brand. Uses the store default (Settings → Listing
      // Defaults) or "1 Month" when unset. Authoritative: overrides anything the
      // passes above may have put here (e.g. a stray make value). For "choose one"
      // aspects only a listed value is set (1 Month ≈ 30 Days), so eBay never gets
      // an invalid term; otherwise the free-text value is written.
      const warrantyVal = String(listingDefaults?.warranty || '').trim() || '1 Month'
      for (const s of specs) {
        if (!/warrant/i.test(s.name)) continue
        if (s.selectionOnly && s.allowed.length) {
          const m = inAllowedOf(s.allowed, warrantyVal)
            || (/1\s*month|30\s*day/i.test(warrantyVal) ? s.allowed.find((v: string) => /1\s*month|30\s*day/i.test(v)) : undefined)
          if (m) aspects[s.name] = [m] // else leave any valid value already set (never a make, per the derive/Pass-3 fixes)
        } else {
          aspects[s.name] = [warrantyVal]
        }
      }
    }
  } catch (_) { /* best effort */ }
  // Manual overrides win over the AI — the user's corrections in the listing
  // preview (and, later, the mapping page) are authoritative.
  const ov = part.ebay_overrides || {}
  if (ov.specifics && typeof ov.specifics === 'object') {
    for (const [k, v] of Object.entries(ov.specifics)) {
      if (v == null || v === '') delete aspects[k]
      else aspects[k] = [String(v)]
    }
  }
  if (Array.isArray(ov.fitment)) fitmentList = ov.fitment
  return { aspects, fitmentList, specs: specsOut }
}

// Build the full listing description (body + "Compatible with" block + footer)
// exactly as it will be sent to eBay. Shared by publish + preview so the preview
// is a faithful image of the real listing.
function buildDescription(part: any, _fitmentList: any[], footer: string): string {
  // Just the product description + the store footer. Vehicle fitment is NOT
  // repeated here — it lives in the item specifics and the Parts Compatibility
  // list (which is what eBay search actually uses), so duplicating it in the
  // description adds no search value and clutters the listing.
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const descBody = part.description || part.notes || part.title || ''
  return [descBody, footer].filter(Boolean).map((s: string) => esc(s).replace(/\n/g, '<br>')).join('<br><br>') || (part.title || part.sku || '')
}

// Fill blank make/model/year on the part from its linked donor car. Parts added
// in the app already copy these from the car, but imported / older parts often
// have them blank — and blank make+model means NO eBay Parts Compatibility gets
// built (the donor can't be injected). Mutates `part` in place; best-effort.
async function hydrateVehicleFromCar(sb: any, part: any): Promise<void> {
  if (!part?.car_id) return
  if (part.make && part.model && part.year) return
  try {
    const { data: car } = await sb.from('cars').select('make, model, year').eq('id', part.car_id).single()
    if (car) {
      if (!part.make)  part.make  = car.make
      if (!part.model) part.model = car.model
      if (!part.year)  part.year  = car.year
    }
  } catch (_) { /* best effort — leave part as-is */ }
}

// ── eBay category learning ("Part type (smart)") ───────────────────────────
// When the user corrects a part's eBay category we remember it per store, keyed
// by the internal Category+Subcategory. When the subcategory is generic ("Other"
// or blank) we refine the key with a 1–2 word part-type token from the title so a
// broad bucket (e.g. Brakes/Other) doesn't over-generalise. The key MUST be
// computed identically for the learn-write and the lookup — hence one function.
function partTypeToken(part: any): string {
  let t = String(part.title || '').toLowerCase()
  const pn = String(part.part_number || '').toLowerCase().trim()
  if (pn) t = t.split(pn).join(' ')
  t = t.replace(/\b\d{4}(\s*[-/]\s*\d{2,4})?\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
  const strip = [part.make, part.model].filter(Boolean).join(' ').toLowerCase().split(/\s+/).filter(Boolean)
  const FILLER = new Set<string>(['front', 'rear', 'back', 'left', 'right', 'lh', 'rh', 'driver', 'passenger', 'side', 'genuine', 'oem', 'used', 'pre', 'owned', 'the', 'for', 'with', 'and', 'assembly', 'assy', 'part', 'parts', 'spare', 'set', 'pair', 'kit', 'unit', 'complete', ...strip])
  const words = t.split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w) && !/^\d+$/.test(w))
  return words.slice(0, 2).sort().join(' ') // sorted → order-independent (Headlight Halogen == Halogen Headlight)
}
function categoryKeyFor(part: any): string {
  const cat = String(part.category || '').trim().toLowerCase()
  const sub = String(part.subcategory || '').trim().toLowerCase()
  const base = `${cat}|${sub}`
  return (!sub || sub === 'other') ? `${base}|${partTypeToken(part)}` : base
}
function learnedCategoryFor(settings: any, part: any): { id: string; name: string } | null {
  const map = settings?.categoryLearning
  if (!map || typeof map !== 'object') return null
  const hit = map[categoryKeyFor(part)]
  return hit && hit.id ? { id: String(hit.id), name: String(hit.name || '') } : null
}

// Resolve the package weight (grams) + dimensions (cm) exactly as publish does:
// part weight > category preset > store default, guarded against zero/sub-gram.
function resolveShipping(part: any, shipCats: any, shipDefW: number, shipDefDims: any) {
  const preset = shipCats[part.category] || {}
  const presetOrDefaultG = +preset.weightG > 0 ? +preset.weightG : shipDefW
  let weightG = Math.round(+part.weight > 0 ? +part.weight : presetOrDefaultG)
  if (!Number.isFinite(weightG) || weightG < 2) weightG = Math.round(presetOrDefaultG)
  const dimL = +preset.l > 0 ? +preset.l : (+shipDefDims.l > 0 ? +shipDefDims.l : 30)
  const dimW = +preset.w > 0 ? +preset.w : (+shipDefDims.w > 0 ? +shipDefDims.w : 20)
  const dimH = +preset.h > 0 ? +preset.h : (+shipDefDims.h > 0 ? +shipDefDims.h : 15)
  return { weightG, dimL, dimW, dimH }
}

// Application access token (client-credentials) for the Buy/Commerce data APIs
// (Browse, Catalog) — no user consent needed; cached in-isolate until expiry.
let _appToken = { token: '', exp: 0 }
async function getAppToken(): Promise<string> {
  if (_appToken.token && _appToken.exp - Date.now() > 60000) return _appToken.token
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${APP_ID}:${CERT_ID}`)}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
  })
  const d = await res.json()
  if (!d.access_token) throw new Error(`eBay app token failed: ${d.error_description || 'unknown'}`)
  _appToken = { token: d.access_token, exp: Date.now() + (d.expires_in || 7200) * 1000 }
  return d.access_token
}

// ── Multi-marketplace support ────────────────────────────────────────────────
// A store's marketplace (settings.marketplace, default EBAY_AU) drives the eBay
// headers, currency, and which category_maps row resolves the category id at
// list time. Parts store only the neutral friendly category; the eBay id is
// resolved here, per the store's marketplace — never stored on the part.
const MARKETPLACE_CFG: Record<string, { currency: string; lang: string; treeId: string }> = {
  EBAY_AU: { currency: 'AUD', lang: 'en-AU', treeId: '15' },
  EBAY_US: { currency: 'USD', lang: 'en-US', treeId: '100' }, // US vehicle parts = eBay Motors tree 100
  EBAY_GB: { currency: 'GBP', lang: 'en-GB', treeId: '3' },
  EBAY_CA: { currency: 'CAD', lang: 'en-CA', treeId: '2' },
}
// Legacy AU category ids — fallback if category_maps has no row (matches the
// pre-multi-country hardcoded map, so AU behaviour is unchanged).
const AU_CATEGORY_FALLBACK: Record<string, string> = {
  'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
  'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
  'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
  'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
  'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
  'Other Car & Truck Parts':'9886','Legacy Items':'9886',
}
async function storeMarketplace(sb: any, storeId: string): Promise<{ mp: string; currency: string; lang: string; treeId: string }> {
  let mp = 'EBAY_AU'
  try {
    const { data } = await sb.from('stores').select('settings').eq('id', storeId).single()
    const m = data?.settings?.marketplace
    if (m && MARKETPLACE_CFG[m]) mp = m
  } catch (_) { /* default AU */ }
  return { mp, ...MARKETPLACE_CFG[mp] }
}
// friendly category -> eBay category id for this marketplace (from category_maps,
// built by the ebay-taxonomy fn). Falls back to the legacy AU ids.
async function categoryMapFor(sb: any, mp: string): Promise<Record<string, string>> {
  const map: Record<string, string> = { ...AU_CATEGORY_FALLBACK }
  try {
    const { data } = await sb.from('category_maps').select('friendly_category, ebay_category_id').eq('marketplace', mp)
    for (const r of (data || [])) if (r.ebay_category_id) map[r.friendly_category] = r.ebay_category_id
  } catch (_) { /* fallback stands */ }
  return map
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  console.log(`[${EDGE_FN_VERSION}] ${req.method} request received`)
  try {
    return await handleRequest(req)
  } catch (e: any) {
    console.error('Unhandled error:', e.message)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})

async function handleRequest(req: Request): Promise<Response> {
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const body = await req.json()
  const { action, storeId, jobId } = body

  // ── Purge SAFETY: report-only scan (this is what the daily cron calls) ───────
  // Finds stores past their retention window and EMAILS an alert — it NEVER
  // deletes. Nothing is erased without an explicit, confirmed manual purge below.
  if (action === 'purge_scan') {
    const { data: due } = await sb.from('stores')
      .select('id, name, deleted_at, purge_after').not('deleted_at', 'is', null)
      .lte('purge_after', new Date().toISOString())
    const list = due || []
    let emailed = false
    const RESEND = Deno.env.get('RESEND_API_KEY')
    // Alert recipient comes from the System admin panel (system_settings), then env, then default.
    const { data: sysRow } = await sb.from('system_settings').select('settings').eq('id', 1).maybeSingle()
    const to = sysRow?.settings?.purgeAlertEmail || Deno.env.get('PURGE_ALERT_EMAIL') || 'leap00@gmail.com'
    if (list.length && RESEND) {
      const rows = list.map((s: any) => `• ${s.name} (deleted ${String(s.deleted_at).slice(0, 10)}, retention ended ${String(s.purge_after).slice(0, 10)})`).join('\n')
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'PartVault <noreply@partvault.app>', to: [to],
            subject: `[PartVault] ${list.length} store(s) awaiting permanent deletion — action required`,
            text: `These stores have passed their retention window and are awaiting PERMANENT deletion.\n\nNOTHING has been deleted. No data is erased until you confirm.\n\n${rows}\n\nReview and confirm in the admin before anything is removed.`,
          }),
        })
        emailed = r.ok
      } catch (_) { /* email best-effort */ }
    }
    return json({ ok: true, version: EDGE_FN_VERSION, due: list.length, emailed, needsResendKey: !RESEND && list.length > 0, stores: list.map((s: any) => ({ id: s.id, name: s.name })) })
  }

  // ── CONFIRMED manual purge — the only path that actually deletes ─────────────
  // Requires an explicit confirm flag + the exact store IDs the human reviewed,
  // so it can never run unattended or mass-delete. (Phone/SMS second factor to be
  // added once Twilio is set up.)
  if (action === 'purge_deleted_stores') {
    if (body.confirm !== 'PERMANENTLY-DELETE' || !Array.isArray(body.storeIds) || !body.storeIds.length) {
      return json({ error: 'Confirmed purge requires confirm:"PERMANENTLY-DELETE" and an explicit storeIds list.' }, 400)
    }
    // Only delete stores that are genuinely deleted AND past their window.
    const { data: eligible } = await sb.from('stores')
      .select('id').in('id', body.storeIds).not('deleted_at', 'is', null).lte('purge_after', new Date().toISOString())
    const ids = (eligible || []).map((s: any) => s.id)
    let purged = 0
    for (const id of ids) {
      try {
        try {
          const { data: files } = await sb.storage.from('part-photos').list(id, { limit: 1000 })
          if (files?.length) await sb.storage.from('part-photos').remove(files.map((f: any) => `${id}/${f.name}`))
        } catch (_) { /* storage best-effort */ }
        const { error } = await sb.from('stores').delete().eq('id', id)
        if (!error) purged++
      } catch (_) { /* continue */ }
    }
    return json({ ok: true, version: EDGE_FN_VERSION, requested: body.storeIds.length, eligible: ids.length, purged })
  }

  // ── XML HELPERS ─────────────────────────────────────────────────────────────

  const getTag = (xml: string, tag: string): string =>
    xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))?.[1]?.trim() ?? ''

  const getTotalPages = (xml: string): number =>
    parseInt(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? '1')

  const getItemIds = (xml: string): string[] =>
    [...xml.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map(m => m[1])

  const parseEbayWeight = (xml: string): number | null => {
    const majorMatch = xml.match(/<WeightMajor[^>]*\bunit="([^"]*)"[^>]*>([^<]*)<\/WeightMajor>/i)
      ?? xml.match(/<WeightMajor[^>]*>([^<]*)<\/WeightMajor>/i)
    const minorMatch = xml.match(/<WeightMinor[^>]*\bunit="([^"]*)"[^>]*>([^<]*)<\/WeightMinor>/i)
      ?? xml.match(/<WeightMinor[^>]*>([^<]*)<\/WeightMinor>/i)

    const majorUnit = majorMatch?.length === 3 ? majorMatch[1].toLowerCase() : ''
    const majorVal  = parseFloat(majorMatch?.length === 3 ? majorMatch[2] : (majorMatch?.[1] ?? '')) || 0
    const minorUnit = minorMatch?.length === 3 ? minorMatch[1].toLowerCase() : ''
    const minorVal  = parseFloat(minorMatch?.length === 3 ? minorMatch[2] : (minorMatch?.[1] ?? '')) || 0

    if (majorVal === 0 && minorVal === 0) return null

    const toGrams = (v: number, u: string): number => {
      switch (u) {
        case 'lbs': return v * 453.592
        case 'oz':  return v * 28.3495
        case 'kg':  return v * 1000
        case 'gm': case 'g': return v
        default: console.warn(`Unknown weight unit: "${u}"`); return 0
      }
    }

    const grams = Math.round(toGrams(majorVal, majorUnit) + toGrams(minorVal, minorUnit))
    return grams < 2 ? null : grams
  }

  const parseEbayStartDate = (xml: string): string | null =>
    getTag(xml, 'StartTime').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null

  const extractItemSpecifics = (xml: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const m of xml.matchAll(/<NameValueList>(.*?)<\/NameValueList>/gs)) {
      const name = getTag(m[1], 'Name')
      const value = getTag(m[1], 'Value')
      if (name) result[name] = value
    }
    return result
  }

  const parseTransactions = (xml: string): Array<{ itemId: string; title: string; salePrice: number; shipping: number; soldAt: string | null }> => {
    const results: Array<{ itemId: string; title: string; salePrice: number; shipping: number; soldAt: string | null }> = []
    for (const txMatch of xml.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)) {
      const txXml = txMatch[1]
      const itemSection = txXml.match(/<Item>([\s\S]*?)<\/Item>/)?.[1] ?? ''
      const itemId = getTag(itemSection, 'ItemID')
      if (!itemId) continue
      const title     = getTag(itemSection, 'Title')
      const salePrice = parseFloat(getTag(txXml, 'TransactionPrice')) || 0
      // Shipping the buyer paid: prefer the explicit shipping cost, else infer
      // from total paid minus item price.
      const explicitShip = parseFloat(getTag(txXml, 'ShippingServiceCost'))
      const amountPaid   = parseFloat(getTag(txXml, 'AmountPaid'))
      const shipping = !isNaN(explicitShip) ? explicitShip : (!isNaN(amountPaid) ? Math.max(0, amountPaid - salePrice) : 0)
      const soldAt    = getTag(txXml, 'PaidTime') || getTag(txXml, 'CreatedDate') || null
      results.push({ itemId, title, salePrice, shipping, soldAt })
    }
    return results
  }

  const fetchItemDetails = async (itemIds: string[]): Promise<Record<string, any>> => {
    const url = `https://open.api.ebay.com/shopping?callname=GetMultipleItems&responseencoding=JSON&appid=${APP_ID}&ItemID=${itemIds.join(',')}&IncludeSelector=Details,ItemSpecifics&version=967&siteid=15`
    try {
      const res = await fetch(url)
      if (!res.ok) return {}
      const data = await res.json()
      const map: Record<string, any> = {}
      for (const item of (data?.Item || [])) {
        if (item?.ItemID) map[item.ItemID] = item
      }
      return map
    } catch { return {} }
  }

  // ── eBay TRADING API ────────────────────────────────────────────────────────

  const trading = async (token: string, certId: string, callName: string, xmlBody: string): Promise<string> => {
    const res = await fetch(`${PROXY}/ebay/trading`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Authorization': `Bearer ${token}`,
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-APP-NAME': APP_ID,
        'X-EBAY-API-CERT-NAME': certId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-SITEID': '15',
      },
      body: xmlBody,
    })
    return res.text()
  }

  // ── TOKEN MANAGEMENT ────────────────────────────────────────────────────────

  const getToken = async (): Promise<{ token: string; certId: string }> => {
    const { data: rows, error } = await sb.rpc('get_ebay_tokens', { p_store_id: storeId })
    if (error || !rows?.length) throw new Error('eBay token not found — please reconnect in Settings')
    const t = rows[0]
    if (!t.access_token) throw new Error('No eBay access token — please reconnect in Settings')

    const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0
    if (expiresAt && expiresAt - Date.now() >= TOKEN_REFRESH_BUFFER_MS) {
      return { token: t.access_token, certId: CERT_ID }
    }

    if (!t.refresh_token) throw new Error('Access token expired — please reconnect in Settings')

    console.log(`Refreshing token (expires ${t.expires_at})...`)
    const credentials = btoa(`${APP_ID}:${CERT_ID}`)
    const refreshRes = await fetch(EBAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: t.refresh_token,
        scope:         EBAY_SCOPES,
      }),
    })
    const refreshData = await refreshRes.json()
    if (!refreshData.access_token) {
      throw new Error(`Token refresh failed: ${refreshData.error_description || 'unknown'} — please reconnect in Settings`)
    }

    const newExpiresAt = new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
    const { error: updateErr } = await sb.rpc('update_ebay_access_token', {
      p_store_id:     storeId,
      p_access_token: refreshData.access_token,
      p_expires_at:   newExpiresAt,
      p_expires_in:   refreshData.expires_in,
    })
    if (updateErr) console.error('Failed to persist refreshed token:', updateErr.message)
    else console.log(`Token refreshed, new expiry: ${newExpiresAt}`)

    return { token: refreshData.access_token, certId: CERT_ID }
  }

  // List item IDs for everything STARTED in the last `days` days via GetSellerList.
  // Unlike GetMyeBaySelling (eBay's cached "My eBay" view) this hits the live
  // listing store, so it reliably includes listings created minutes ago. Returns
  // active + recently-ended alike — that's fine: the caller dedupes, import fetches
  // each item's real status, and for reconcile a few extra ids can only REDUCE
  // false "stale" flags (never add false "missing" beyond a harmless re-import).
  const fetchRecentlyListedIds = async (token: string, certId: string, days: number): Promise<string[]> => {
    const to   = new Date()
    const from = new Date(Date.now() - days * 86400000)
    const ids: string[] = []
    let page = 1, totalPages = 1
    do {
      const xml = await trading(token, certId, 'GetSellerList', `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <StartTimeFrom>${from.toISOString()}</StartTimeFrom>
  <StartTimeTo>${to.toISOString()}</StartTimeTo>
  <GranularityLevel>Coarse</GranularityLevel>
  <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerListRequest>`)
      if (getTag(xml, 'Ack') === 'Failure') throw new Error(getTag(xml, 'LongMessage') || 'GetSellerList error')
      if (page === 1) totalPages = getTotalPages(xml)
      getItemIds(xml).forEach(id => ids.push(id))
      page++
    } while (page <= Math.min(totalPages, 25))
    return ids
  }

  const fetchAllIds = async (token: string, certId: string, listType: string): Promise<string[]> => {
    // eBay caps SoldList DurationInDays at 60; older sales come via backfill_orders
    // (GetSellerTransactions with ModifiedTimeFilter), not this listing query.
    const durationParam = listType === 'SoldList' ? '<DurationInDays>59</DurationInDays>' : ''
    const xml1 = await trading(token, certId, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${listType}><Include>true</Include>${durationParam}<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination></${listType}>
</GetMyeBaySellingRequest>`)
    if (getTag(xml1, 'Ack') === 'Failure') throw new Error(getTag(xml1, 'LongMessage') || 'eBay API error')

    const totalPages = getTotalPages(xml1)
    const ids: string[] = getItemIds(xml1)
    for (let p = 2; p <= Math.min(totalPages, 50); p++) {
      const xml = await trading(token, certId, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${listType}><Include>true</Include>${durationParam}<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${p}</PageNumber></Pagination></${listType}>
</GetMyeBaySellingRequest>`)
      getItemIds(xml).forEach(id => ids.push(id))
    }

    // GetMyeBaySelling's view lags hours-to-a-day on brand-new listings, so
    // freshly-listed items were silently skipped by both import and reconcile (the
    // total looked right while the newest items were absent). Supplement the active
    // list with a recent-start-time GetSellerList pass and merge. Best-effort —
    // never let this extra pass fail the whole enumeration.
    if (listType === 'ActiveList') {
      try {
        const recent = await fetchRecentlyListedIds(token, certId, 30)
        recent.forEach(id => ids.push(id))
      } catch (e) {
        console.error('GetSellerList supplement failed:', (e as Error).message)
      }
    }

    return [...new Set(ids)]
  }

  // ── ROW BUILDERS ────────────────────────────────────────────────────────────

  const buildPartRow = (xml: string, sku: string) => {
    const listingStatus = getTag(xml, 'ListingStatus')
    const sellingState  = getTag(xml, 'SellingState')
    const priceStr      = getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'BuyItNowPrice') || getTag(xml, 'CurrentPrice')
    const descRaw       = getTag(xml, 'Description')
    const weight        = parseEbayWeight(xml)

    let status    = 'in_stock'
    let soldPrice = null
    let soldDate  = null
    if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
      status    = 'sold'
      soldPrice = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null
      soldDate  = getTag(xml, 'PaidTime') || null
    } else if (listingStatus === 'Active') {
      status = 'listed'
    }

    return {
      store_id:      storeId,
      sku,
      title:         getTag(xml, 'Title'),
      status,
      condition:     getTag(xml, 'ConditionDisplayName') || 'Used',
      description:   descRaw.replace(/<[^>]*>/g, '').trim().substring(0, 2000),
      list_price:    parseFloat(priceStr) || 0,
      sold_price:    soldPrice,
      sold_date:     soldDate,
      weight,
      weight_source: weight !== null ? 'ebay' : null,
      part_number:   extractItemSpecifics(xml)['Manufacturer Part Number'] ?? null,
      source:        'ebay_import',
      acquired_date: parseEbayStartDate(xml),
      costs:         { acquisition:0, labour:0, storage:0, packaging:0, postage:0, holding:0 },
      ai_assessed:   false,
    }
  }

  const buildListingRow = (xml: string, partId: string) => {
    const itemId        = getTag(xml, 'ItemID')
    const ebaySkuRaw    = getTag(xml, 'SKU')
    const listingStatus = getTag(xml, 'ListingStatus')
    const sellingState  = getTag(xml, 'SellingState')
    const priceStr      = getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'BuyItNowPrice') || getTag(xml, 'CurrentPrice')
    const startTime     = getTag(xml, 'StartTime')
    const endTime       = getTag(xml, 'EndTime')

    // Active listings use status 'live' here (matches the existing rows and the
    // listings_status_check constraint — 'active' is NOT an allowed value).
    let status    = 'live'
    let soldPrice = null
    let soldAt    = null
    if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
      status    = 'sold'
      soldPrice = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null
      soldAt    = getTag(xml, 'PaidTime') || null
    } else if (listingStatus !== 'Active') {
      status = 'ended'
    }

    const photos = [...xml.matchAll(/<PictureURL>(.*?)<\/PictureURL>/g)]
      .map(m => m[1])
      .slice(0, 12)
      .map(url => ({ ebay_url: url }))

    const platform_data = {
      ItemID:                itemId,
      Title:                 getTag(xml, 'Title'),
      SKU:                   ebaySkuRaw,
      ListingStatus:         listingStatus,
      SellingState:          sellingState,
      ConditionDisplayName:  getTag(xml, 'ConditionDisplayName'),
      CategoryID:            getTag(xml, 'CategoryID'),
      ConvertedCurrentPrice: getTag(xml, 'ConvertedCurrentPrice'),
      BuyItNowPrice:         getTag(xml, 'BuyItNowPrice'),
      StartTime:             startTime,
      EndTime:               endTime,
      ItemSpecifics:         extractItemSpecifics(xml),
    }

    return {
      part_id:             partId,
      store_id:            storeId,
      platform:            'ebay',
      platform_listing_id: itemId,
      platform_sku:        ebaySkuRaw || null,
      status,
      list_price:          parseFloat(priceStr) || 0,
      sold_price:          soldPrice,
      listed_at:           startTime || null,
      ended_at:            endTime || null,
      sold_at:             soldAt,
      platform_data,
      photos,
      photos_archived:     false,
    }
  }

  // ── PHOTOS TABLE DUAL-WRITE ─────────────────────────────────────────────────
  // Mirrors eBay listing photos into the normalised `photos` table, keyed to the
  // part. Delete-then-insert keeps it idempotent: re-imports refresh, never duplicate.
  // Only touches source='ebay_import' rows, so manually uploaded photos are never removed.
  const syncPhotosForPart = async (xml: string, partId: string) => {
    const urls = [...xml.matchAll(/<PictureURL>(.*?)<\/PictureURL>/g)]
      .map(m => m[1])
      .slice(0, 12)
    await sb.from('photos').delete()
      .eq('parent_type', 'part')
      .eq('parent_id', partId)
      .eq('source', 'ebay_import')
    if (urls.length) {
      const { error } = await sb.from('photos').insert(
        urls.map((url, i) => ({
          parent_type: 'part', parent_id: partId, ebay_url: url,
          display_order: i, is_primary: i === 0, source: 'ebay_import',
        }))
      )
      if (error) console.warn('photos table sync failed', partId, error.message)
    }
  }

  // ── RESPONSE HELPER ─────────────────────────────────────────────────────────

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  // One summary row per eBay sync into the existing audit_log (table_name 'sync',
  // action 'SYNC'). Shows in the Activity view as a single readable line instead
  // of the hundreds of per-row part/listing changes the triggers already record.
  // Best-effort: a logging failure must never fail the sync itself.
  const logSyncEvent = async (sid: string, summary: string, data: Record<string, unknown> = {}) => {
    try {
      await sb.from('audit_log').insert({
        id:         crypto.randomUUID(),
        store_id:   sid,
        table_name: 'sync',
        record_id:  crypto.randomUUID(),
        action:     'SYNC',
        old_data:   null,
        new_data:   { summary, ...data },
        changed_by: null, // unattended → shows as 'system' in the Activity view
        changed_at: new Date().toISOString(),
      })
    } catch (_) { /* logging is best-effort */ }
  }

  // Stamp "last sync" from the lightweight 5-min live checks too, so the Sync
  // panel reflects them — throttled to ~20 min so audit_log doesn't bloat.
  const touchLiveSync = async (sid: string, summary: string) => {
    try {
      const { data } = await sb.from('audit_log').select('changed_at')
        .eq('store_id', sid).eq('table_name', 'sync').order('changed_at', { ascending: false }).limit(1)
      const last = data?.[0]?.changed_at ? new Date(data[0].changed_at).getTime() : 0
      if (Date.now() - last > 20 * 60 * 1000) await logSyncEvent(sid, summary, { kind: 'live', ok: true })
    } catch (_) { /* best-effort */ }
  }

  // ── ACTIONS ─────────────────────────────────────────────────────────────────

  try {

    if (action === 'status') {
      const { data: job } = await sb.from('jobs').select('*').eq('id', jobId).single()
      return json(job ?? { error: 'Job not found' })
    }

    if (action === 'cancel') {
      await sb.from('jobs')
        .update({ status: 'cancelled', completed_at: new Date().toISOString() })
        .eq('id', jobId)
      return json({ ok: true })
    }

    if (action === 'exchange_oauth_code') {
      const { code } = body
      if (!code) throw new Error('Missing authorisation code')

      // Keyset comes from edge-function secrets (platform-level), not per-store data.
      if (!CERT_ID) return json({ error: 'Server eBay credentials not configured (EBAY_CERT_ID secret is missing).' }, 500)

      const credentials = btoa(`${APP_ID}:${CERT_ID}`)
      const tokenRes = await fetch(EBAY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: RUNAME,
        }),
      })

      const tokens = await tokenRes.json()
      if (!tokens.access_token) {
        throw new Error(tokens.error_description || tokens.error || 'eBay token exchange failed')
      }

      // Marketplace match guard: the connected eBay account's registration site
      // must match the store's marketplace (a US account can't list AUD/AU
      // categories and vice-versa). Definite mismatch → reject BEFORE storing
      // tokens; unknown/unreadable site → allow (fail-open, eBay is the backstop).
      try {
        const mkt = await storeMarketplace(sb, storeId)
        const SITE_TO_MP: Record<string, string> = {
          'Australia': 'EBAY_AU', 'US': 'EBAY_US', 'eBayMotors': 'EBAY_US',
          'UK': 'EBAY_GB', 'Canada': 'EBAY_CA', 'CanadaFrench': 'EBAY_CA',
        }
        const xml = `<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetUserRequest>`
        const resp = await trading(tokens.access_token, CERT_ID, 'GetUser', xml)
        const site = (resp.match(/<Site>([^<]+)<\/Site>/) || [])[1] || ''
        const acctMp = SITE_TO_MP[site] || ''
        if (acctMp && acctMp !== mkt.mp) {
          const label: Record<string, string> = { EBAY_AU: 'Australia', EBAY_US: 'the United States', EBAY_GB: 'the United Kingdom', EBAY_CA: 'Canada' }
          return json({ error: `This store is set to ${label[mkt.mp] || mkt.mp}, but the eBay account you connected is registered in ${label[acctMp] || site}. Connect a matching eBay account, or create a new store for ${label[acctMp] || 'that country'}.` }, 400)
        }
      } catch (_) { /* site unreadable — allow; eBay rejects mismatches at publish */ }

      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      // Create-or-update the store's ebay_tokens row and persist BOTH tokens.
      // (The row no longer pre-exists from a cert-save step, and the refresh
      //  token must be stored so future silent refreshes work.)
      const { error: updateErr } = await sb.rpc('store_ebay_oauth_tokens', {
        p_store_id:      storeId,
        p_access_token:  tokens.access_token,
        p_refresh_token: tokens.refresh_token,
        p_expires_at:    expiresAt,
        p_expires_in:    tokens.expires_in,
      })
      if (updateErr) throw new Error(`Failed to store token: ${updateErr.message}`)

      console.log(`[exchange_oauth_code] Token stored, expires ${expiresAt}`)
      return json({ success: true, expires_at: expiresAt })
    }

    if (action === 'start') {
      const { token, certId } = await getToken()

      const activeIds = await fetchAllIds(token, certId, 'ActiveList')
      const soldIds   = await fetchAllIds(token, certId, 'SoldList')
      const allIds    = [...new Set([...activeIds, ...soldIds])]

      const { data: job, error: jobErr } = await sb.from('jobs').insert({
        store_id:     storeId,
        type:         'ebay_import',
        status:       'running',
        total_items:  allIds.length,
        current_item: 'Ready to process...',
        started_at:   new Date().toISOString(),
        meta: { all_item_ids: allIds, batch_offset: 0, failed_reasons: {} },
      }).select().single()

      if (jobErr) throw new Error(`Failed to create job: ${jobErr.message}`)
      return json({ jobId: job.id, totalIds: allIds.length, needsProcessing: true })
    }

    if (action === 'process_chunk') {
      const processChunk = async (): Promise<Response> => {
        const { data: job, error: jobErr } = await sb.from('jobs').select('*').eq('id', jobId).single()
        if (jobErr || !job) throw new Error('Job not found')
        if (job.status === 'cancelled') return json({ status: 'cancelled' })

        const { token, certId } = await getToken()

        const allIds: string[]                      = job.meta?.all_item_ids  ?? []
        const offset: number                        = job.meta?.batch_offset  ?? 0
        const failedReasons: Record<string, string> = job.meta?.failed_reasons ?? {}
        // Time-box the work instead of a fixed count: process items until ~18s
        // have elapsed (or a hard cap), then persist progress and return. This
        // guarantees forward progress and removes the timeout/retry deadlock that
        // froze the bar on chunks full of slow new-item + photo imports.
        const SOFT_LIMIT_MS = 18 * 1000
        const HARD_CAP      = 60 // never look further ahead than this per call
        const chunk = allIds.slice(offset, offset + HARD_CAP)

        if (chunk.length === 0) {
          const summary = job.result_summary ?? {}
          await sb.from('jobs').update({
            status:       'completed',
            completed_at: new Date().toISOString(),
            current_item: `✓ Complete — ${summary.imported ?? 0} imported, ${summary.skipped ?? 0} skipped, ${job.failed_items ?? 0} failed`,
          }).eq('id', jobId)
          return json({ status: 'completed', job })
        }

        let imported  = job.result_summary?.imported ?? 0
        let skipped   = job.result_summary?.skipped  ?? 0
        let failed    = job.failed_items    ?? 0
        let processed = job.processed_items ?? 0

        const { data: existingInChunk } = await sb.from('listings')
          .select('platform_listing_id')
          .eq('store_id', storeId)
          .eq('platform', 'ebay')
          .in('platform_listing_id', chunk)
        const existingSet = new Set((existingInChunk ?? []).map((l: any) => l.platform_listing_id))

        const startedAt = Date.now()
        let doneThisCall = 0 // how many ids we actually advanced past this call
        for (const itemId of chunk) {
          // Stop once the time budget is spent — but always do at least one item
          // so we can't stall (a single slow item still advances the offset).
          if (doneThisCall > 0 && Date.now() - startedAt > SOFT_LIMIT_MS) break
          doneThisCall++
          if (existingSet.has(itemId)) { skipped++; processed++; continue }
          try {
            const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)

            if (!xml.includes('<Ack>Success</Ack>') && !xml.includes('<Ack>Warning</Ack>')) {
              throw new Error(getTag(xml, 'LongMessage') || 'eBay API error')
            }

            const ebaySkuRaw = getTag(xml, 'SKU')
            let partId: string

            // Each live eBay listing is its own inventory part. Reuse a part when
            // its SKU matches AND it has no *other* live listing (a relist — old
            // listing ended, new item id) — but if the matched part already has a
            // different live listing, this is a concurrent duplicate, so it gets
            // its own part under a fresh internal SKU (eBay's SKU stays on the
            // listing's platform_sku). Keeps inventory count = eBay live count.
            const freshSku = async () => {
              const { data: g, error: e } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
              if (e || !g) throw new Error(`SKU generation failed: ${e?.message}`)
              return g as string
            }
            // Create a part with a guaranteed-unique store SKU. eBay SKUs are NOT
            // unique — sellers reuse one custom label (e.g. "NEW LIBERTY") across
            // many listings — so inserting the eBay SKU verbatim can violate
            // parts_sku_store_unique and silently drop the listing. On any unique
            // collision, fall back to a freshly generated internal SKU and retry.
            const makePart = async (sku: string): Promise<string> => {
              // Guarantee a unique store SKU. eBay SKUs aren't unique (sellers reuse
              // one label across many parts) AND generate_next_sku can itself return
              // an already-used value, so the final fallbacks use the eBay item id —
              // globally unique, cannot collide. Otherwise the listing is dropped.
              for (let attempt = 0; attempt < 5; attempt++) {
                const candidate =
                  attempt === 0 ? sku :
                  attempt === 1 ? await freshSku() :
                  attempt === 2 ? `EB-${itemId}` :
                                  `EB-${itemId}-${attempt}`
                const { data: np, error: pErr } = await sb.from('parts')
                  .insert(buildPartRow(xml, candidate)).select('id').single()
                if (!pErr) return np.id as string
                if (!(pErr.code === '23505' || /parts_sku_store_unique|duplicate key/i.test(pErr.message || ''))) throw pErr
              }
              throw new Error('Could not allocate a unique SKU for part')
            }

            if (ebaySkuRaw) {
              // limit(1), NOT maybeSingle: duplicate eBay SKUs can already have
              // produced multiple parts, and maybeSingle THROWS on >1 row — which
              // would fail the import. Take the first match instead.
              const { data: existingParts } = await sb.from('parts')
                .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).limit(1)
              const existingPart = existingParts?.[0]
              if (existingPart) {
                const { data: liveOther } = await sb.from('listings')
                  .select('id').eq('store_id', storeId).eq('platform', 'ebay').eq('part_id', existingPart.id)
                  .in('status', ['active', 'live']).neq('platform_listing_id', itemId).is('deleted_at', null)
                  .limit(1).maybeSingle()
                // Concurrent duplicate → new part (fresh SKU); else reuse (relist).
                partId = liveOther ? await makePart(await freshSku()) : existingPart.id
              } else {
                partId = await makePart(ebaySkuRaw)
              }
            } else {
              partId = await makePart(await freshSku())
            }

            const { error: listingErr } = await sb.from('listings').insert(buildListingRow(xml, partId))
            if (listingErr) throw listingErr
            await syncPhotosForPart(xml, partId)

            imported++; processed++

          } catch (e: any) {
            failed++; processed++
            failedReasons[itemId] = e.message
          }
        }

        const newOffset  = offset + doneThisCall
        const isComplete = newOffset >= allIds.length

        await sb.from('jobs').update({
          processed_items: processed,
          failed_items:    failed,
          current_item: isComplete
            ? `✓ Complete — ${imported} imported, ${skipped} skipped`
            : `Processing ${Math.min(newOffset, allIds.length)} of ${allIds.length}...`,
          status:         isComplete ? 'completed' : 'running',
          completed_at:   isComplete ? new Date().toISOString() : null,
          result_summary: { imported, skipped },
          meta:           { all_item_ids: allIds, batch_offset: newOffset, failed_reasons: failedReasons },
        }).eq('id', jobId)

        return json({
          status: isComplete ? 'completed' : 'running',
          imported, skipped, failed,
          offset: newOffset, total: allIds.length, isComplete,
        })
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<Response>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(json({ error: 'timeout', retry: true }, 408))
        }, FUNCTION_TIMEOUT_MS)
      })
      try {
        const response = await Promise.race([processChunk(), timeoutPromise])
        if (timeoutId) clearTimeout(timeoutId)
        return response
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId)
        throw e
      }
    }

    // Record a single summary line for a manual (client-driven) sync into the
    // audit log. The client passes the composed summary + totals on completion.
    if (action === 'log_sync') {
      await logSyncEvent(storeId, body.summary || 'eBay sync', { kind: 'manual', ...(body.data || {}) })
      return json({ ok: true })
    }

    // Server-side nightly orchestrator (driven by pg_cron). Advances one store's
    // daily run: import → sold orders (backfill) → reconcile. Resumable: state
    // lives in sync_runs, so a later tick picks up exactly where this left off.
    // Reuses the existing actions via internal self-calls (no logic duplicated).
    if (action === 'cron_sync') {
      // The in-app "Sync now" button routes through this SAME resumable pipeline
      // (manual:true) so a manual run behaves exactly like the nightly: it survives
      // tab-close, and a later cron tick resumes the same run. The only differences
      // are the audit-log label and that a manual run forces a fresh pass even if
      // today's nightly already finished. This pipeline is 100% read-only against
      // eBay (start/process_chunk/import_sold_orders/import_fees/reconcile only read).
      const manual = body.manual === true
      // Prefer the store's LOCAL date (passed by the tz-aware cron) so a run is
      // one-per-local-day; fall back to UTC date for manual/legacy calls.
      const runDate = (typeof body.runDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.runDate))
        ? body.runDate : new Date().toISOString().slice(0, 10)
      let { data: run } = await sb.from('sync_runs').select('*').eq('store_id', storeId).eq('run_date', runDate).maybeSingle()
      if (!run) {
        const { data: ins } = await sb.from('sync_runs').insert({ store_id: storeId, run_date: runDate, phase: 'import' }).select().single()
        run = ins
      } else if (manual && run.done) {
        // Explicit manual re-run: reset today's finished run to the top. Subsequent
        // driver calls see done=false and resume this same run (no repeat reset),
        // and the driver stops polling once it gets done:true — so no loop.
        const { data: rst } = await sb.from('sync_runs')
          .update({ phase: 'import', done: false, job_id: null, detail: 'manual sync starting…', updated_at: new Date().toISOString() })
          .eq('id', run.id).select().single()
        run = rst || run
      }
      if (!run) throw new Error('Could not create sync_runs row')
      if (run.done) return json({ done: true, phase: 'done', detail: run.detail })

      const SELF_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ebay-import`
      const selfCall = async (payload: Record<string, unknown>) => {
        const r = await fetch(SELF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
          body: JSON.stringify(payload),
        })
        return await r.json()
      }
      const save = (patch: Record<string, unknown>) =>
        sb.from('sync_runs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', run.id)

      const started = Date.now()
      const BUDGET_MS = 110 * 1000
      let phase: string = run.phase
      let jobIdLocal: string | null = run.job_id
      // Capture each phase's result so the 'done' summary can report real totals.
      let bRes: any = null, fRes: any = null, recRes: any = null

      try {
        while (Date.now() - started < BUDGET_MS && phase !== 'done') {
          if (phase === 'import') {
            if (!jobIdLocal) {
              const s = await selfCall({ action: 'start', storeId })
              if (s.error) throw new Error(s.error)
              jobIdLocal = s.jobId
              await save({ job_id: jobIdLocal, detail: `import: 0/${s.totalIds}` })
            } else {
              const c = await selfCall({ action: 'process_chunk', jobId: jobIdLocal, storeId })
              if (c.error && c.retry) continue
              if (c.error) throw new Error(c.error)
              await save({ detail: `import ${c.offset}/${c.total} · ${c.imported} new, ${c.skipped} existing, ${c.failed} failed` })
              if (c.isComplete || c.status === 'completed') { phase = 'parse'; await save({ phase }) }
            }
          } else if (phase === 'parse') {
            const pr = await selfCall({ action: 'parse_titles', storeId })
            phase = 'backfill'
            await save({ phase, detail: `parse: ${pr.updated ?? 0} make/model filled` })
          } else if (phase === 'backfill') {
            bRes = await selfCall({ action: 'import_sold_orders', storeId, days: 120 })
            phase = 'fees'
            await save({ phase, detail: `sold orders: ${bRes.created ?? 0} new, ${bRes.updated ?? 0} updated` })
          } else if (phase === 'fees') {
            fRes = await selfCall({ action: 'import_fees', storeId, days: 120 })
            phase = 'reconcile'
            await save({ phase, detail: `eBay fees: $${fRes.feeTotal ?? 0} across ${fRes.ordersMatched ?? 0} orders` })
          } else if (phase === 'reconcile') {
            recRes = await selfCall({ action: 'reconcile', storeId })
            phase = 'done'
            await save({ phase, done: true, detail: `done · ${recRes.missingCount ?? 0} missing, ${recRes.staleCount ?? 0} stale on eBay` })
          }
        }
      } catch (e) {
        const msg = (e as Error).message
        // eBay/proxy throttling is transient: don't fail the run or log a scary
        // summary — just record a soft pause and leave done=false so the next
        // 2-minute cron tick resumes from exactly where this left off.
        const isRateLimit = /rate limit|retry after|429|call limit|throttl/i.test(msg)
        if (isRateLimit) {
          await save({ detail: `paused in ${phase} (rate-limited) — resumes next tick` })
          return json({ phase, paused: true, reason: msg }, 200)
        }
        await save({ detail: `error in ${phase}: ${msg}` })
        await logSyncEvent(storeId, `${manual ? 'Manual' : 'Nightly'} sync failed in ${phase}: ${msg}`, { kind: manual ? 'manual' : 'nightly', ok: false, phase })
        return json({ phase, error: msg }, 200)
      }
      // Record one summary line per completed nightly run.
      if (phase === 'done') {
        const { data: jobRow } = jobIdLocal
          ? await sb.from('jobs').select('result_summary, failed_items').eq('id', jobIdLocal).maybeSingle()
          : { data: null as any }
        const imp = jobRow?.result_summary?.imported ?? 0
        const summary = `${manual ? 'Manual' : 'Nightly'} sync ✓ · ${imp} listings imported · `
          + `${bRes?.created ?? 0} sold new/${bRes?.updated ?? 0} updated · `
          + `$${fRes?.feeTotal ?? 0} fees · `
          + `${recRes?.missingCount ?? 0} missing, ${recRes?.staleCount ?? 0} stale`
        await logSyncEvent(storeId, summary, {
          kind: manual ? 'manual' : 'nightly', ok: true,
          listingsImported: imp, soldNew: bRes?.created ?? 0, soldUpdated: bRes?.updated ?? 0,
          feeTotal: fRes?.feeTotal ?? 0, missing: recRes?.missingCount ?? 0, stale: recRes?.staleCount ?? 0,
        })
      }
      return json({ phase, done: phase === 'done' })
    }

    if (action === 'backfill_orders') {
      const { token, certId } = await getToken()

      const fromDate = body.fromDate
      const toDate   = body.toDate || new Date().toISOString()
      if (!fromDate) throw new Error('fromDate is required')

      let page      = 1
      let hasMore   = true
      let updated    = 0
      let alreadySold = 0
      let notFound   = 0
      const errors: string[] = []

      while (hasMore && page <= 10) {
        const xml = await trading(token, certId, 'GetSellerTransactions', `<?xml version="1.0" encoding="utf-8"?>
<GetSellerTransactionsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ModifiedTimeFilter>
    <TimeFrom>${fromDate}</TimeFrom>
    <TimeTo>${toDate}</TimeTo>
  </ModifiedTimeFilter>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerTransactionsRequest>`)

        if (getTag(xml, 'Ack') === 'Failure') {
          throw new Error(getTag(xml, 'LongMessage') || 'GetSellerTransactions API error')
        }

        const transactions = parseTransactions(xml)
        console.log(`[backfill_orders] ${fromDate.slice(0,10)} page ${page}: ${transactions.length} transactions`)

        for (const tx of transactions) {
          try {
            const { data: listing } = await sb.from('listings')
              .select('id, part_id, status')
              .eq('store_id', storeId)
              .eq('platform', 'ebay')
              .eq('platform_listing_id', tx.itemId)
              .maybeSingle()

            if (!listing) { notFound++; continue }
            if (!tx.salePrice || tx.salePrice <= 0) { notFound++; continue }
            if (listing.status === 'sold') { alreadySold++; continue }

            await sb.from('listings').update({
              status:               'sold',
              sold_price:           tx.salePrice || null,
              sold_at:              tx.soldAt || null,
              reconcile_flagged:    false,
              reconcile_flagged_at: null,
            }).eq('id', listing.id)

            await sb.from('parts').update({
              status: 'sold',
              ...(tx.salePrice ? { sold_price: tx.salePrice } : {}),
              ...(tx.soldAt    ? { sold_date:  tx.soldAt }    : {}),
              ...(tx.shipping  ? { shipping_charged: tx.shipping } : {}),
            }).eq('id', listing.part_id)

            updated++
          } catch (e: any) {
            errors.push(`${tx.itemId}: ${e.message}`)
          }
        }

        hasMore = xml.includes('<HasMoreTransactions>true</HasMoreTransactions>')
        page++
      }

      return json({ updated, alreadySold, notFound, errors: errors.slice(0, 20) })
    }

    if (action === 'import_sold_history') {
      const startTime = Date.now()
      const { token, certId } = await getToken()

      const fromDate = body.fromDate
      const toDate   = body.toDate || new Date().toISOString()
      if (!fromDate) throw new Error('fromDate is required')

      // Collect all transactions for this window
      const allTransactions: Array<{ itemId: string; title: string; salePrice: number; shipping: number; soldAt: string | null }> = []
      let page    = 1
      let hasMoreTx = true

      while (hasMoreTx && page <= 10) {
        const xml = await trading(token, certId, 'GetSellerTransactions', `<?xml version="1.0" encoding="utf-8"?>
<GetSellerTransactionsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ModifiedTimeFilter>
    <TimeFrom>${fromDate}</TimeFrom>
    <TimeTo>${toDate}</TimeTo>
  </ModifiedTimeFilter>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerTransactionsRequest>`)

        if (getTag(xml, 'Ack') === 'Failure') {
          throw new Error(getTag(xml, 'LongMessage') || 'GetSellerTransactions API error')
        }

        allTransactions.push(...parseTransactions(xml))
        hasMoreTx = xml.includes('<HasMoreTransactions>true</HasMoreTransactions>')
        page++
      }

      // Genuine sales only, deduplicated by itemId
      const seen = new Set<string>()
      const genuine = allTransactions.filter(tx => {
        if (tx.salePrice <= 0 || seen.has(tx.itemId)) return false
        seen.add(tx.itemId)
        return true
      })

      if (!genuine.length) return json({ created: 0, skipped: 0, noData: 0, hasMore: false })

      // Check which are already in PartVault
      const itemIds = genuine.map(tx => tx.itemId)
      const { data: existing } = await sb.from('listings')
        .select('platform_listing_id')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .in('platform_listing_id', itemIds)
      const existingIds = new Set((existing || []).map((r: any) => r.platform_listing_id))

      const toCreate = genuine.filter(tx => !existingIds.has(tx.itemId))
      if (!toCreate.length) return json({ created: 0, skipped: existingIds.size, noData: 0, hasMore: false })

      // Fetch item details from Shopping API in batches of 20, with timeout guard
      let created = 0
      let noData  = 0
      const errors: any[] = []

      for (let i = 0; i < toCreate.length; i += 20) {
        // Timeout guard — return hasMore:true so frontend re-calls this same window
        if (Date.now() - startTime > 20000) {
          return json({ created, skipped: existingIds.size, noData, errors: errors.slice(0, 20), hasMore: true })
        }

        const batch   = toCreate.slice(i, i + 20)
        const details = await fetchItemDetails(batch.map(tx => tx.itemId))

        for (const tx of batch) {
          try {
            const detail   = details[tx.itemId]
            const catId    = detail?.PrimaryCategoryID?.toString()
            const category = (catId && CATEGORY_ID_MAP[catId]) || 'Legacy Items'
            if (!detail) noData++
            // Original eBay listing date (StartTime) from the GetMultipleItems
            // detail — so the part/listing carry the real eBay listing date, not
            // our import date. Falls back to null when eBay doesn't return it.
            const startIso  = detail?.StartTime ? String(detail.StartTime) : null
            const startDate = startIso?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null

            const { data: part, error: partErr } = await sb.from('parts').insert({
              store_id:   storeId,
              sku:        `EBH-${tx.itemId}`,
              title:      detail?.Title || tx.title || `eBay Item ${tx.itemId}`,
              category,
              status:     'sold',
              sold_price: tx.salePrice,
              sold_date:  tx.soldAt || null,
              acquired_date: startDate,
              listed_date:   startDate,
              shipping_charged: tx.shipping || null,
              list_price: tx.salePrice,
              condition:  detail?.ConditionDisplayName || 'Used – Good',
              source:     'ebay_history',
              costs:      { acquisition:0, labour:0, storage:0, packaging:0, postage:0, holding:0 },
              ai_assessed: false,
            }).select('id').single()

            if (partErr) { errors.push({ itemId: tx.itemId, error: partErr.message }); continue }

            await sb.from('listings').insert({
              store_id:            storeId,
              part_id:             part.id,
              platform:            'ebay',
              platform_listing_id: tx.itemId,
              status:              'sold',
              list_price:          tx.salePrice,
              sold_price:          tx.salePrice,
              listed_at:           startIso,
              sold_at:             tx.soldAt || null,
              platform_data:       startIso ? { StartTime: startIso } : {},
              photos:              [],
              photos_archived:     false,
            })
            created++
          } catch (e: any) {
            errors.push({ itemId: tx.itemId, error: e.message })
          }
        }
      }

      return json({ created, skipped: existingIds.size, noData, errors: errors.slice(0, 20), hasMore: false })
    }

    if (action === 'backfill_listing_dates') {
      // Repair parts that have no acquired_date by re-fetching their eBay listing
      // StartTime (the original listing date) from the Shopping API. Forward-only
      // keyset pagination by part id, so parts we can't resolve (eBay no longer
      // returns them) aren't retried forever — the client loops until hasMore.
      const started = Date.now()
      const LIMIT = 400
      const afterId = typeof body.afterId === 'string' ? body.afterId : '00000000-0000-0000-0000-000000000000'

      const { data: targetParts } = await sb.from('parts')
        .select('id')
        .eq('store_id', storeId)
        .is('deleted_at', null)
        .is('acquired_date', null)
        .gt('id', afterId)
        .order('id', { ascending: true })
        .limit(LIMIT)

      if (!targetParts?.length) return json({ ok: true, version: EDGE_FN_VERSION, updated: 0, noData: 0, hasMore: false, nextAfterId: null })

      const partIds = targetParts.map((p: any) => p.id)
      const nextAfterId = partIds[partIds.length - 1]

      // Map each part to its eBay listing item id(s).
      const partItems: Record<string, string[]> = {}
      const allItemIds = new Set<string>()
      for (let i = 0; i < partIds.length; i += 300) {
        const { data: ls } = await sb.from('listings')
          .select('part_id, platform_listing_id')
          .eq('store_id', storeId).eq('platform', 'ebay')
          .in('part_id', partIds.slice(i, i + 300))
        for (const l of (ls || [])) {
          if (!l.platform_listing_id) continue
          ;(partItems[l.part_id] ||= []).push(l.platform_listing_id)
          allItemIds.add(l.platform_listing_id)
        }
      }

      // Fetch StartTime for every item id (GetMultipleItems: 20 per call).
      const startById: Record<string, string> = {}
      const ids = [...allItemIds]
      for (let i = 0; i < ids.length && Date.now() - started < 90000; i += 20) {
        const details = await fetchItemDetails(ids.slice(i, i + 20))
        for (const [itemId, d] of Object.entries(details)) {
          if ((d as any)?.StartTime) startById[itemId] = String((d as any).StartTime)
        }
      }

      // Set each part's date to its EARLIEST listing StartTime; backfill the
      // listing.listed_at too. Parts with no recoverable date stay null (→ "—").
      let updated = 0, noData = 0
      for (const pid of partIds) {
        const items = partItems[pid] || []
        const starts = items.map(it => startById[it]).filter(Boolean).sort()
        if (!starts.length) { noData++; continue }
        const iso = starts[0]
        const date = iso.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
        if (!date) { noData++; continue }
        await sb.from('parts').update({ acquired_date: date, listed_date: date }).eq('id', pid)
        for (const it of items) {
          if (startById[it]) {
            await sb.from('listings').update({ listed_at: startById[it] })
              .eq('store_id', storeId).eq('platform', 'ebay').eq('platform_listing_id', it).is('listed_at', null)
          }
        }
        updated++
      }

      return json({ ok: true, version: EDGE_FN_VERSION, updated, noData, hasMore: targetParts.length === LIMIT, nextAfterId })
    }

    if (action === 'sales_match') {
      // Reconcile against eBay's order-complete source (Fulfillment getOrders),
      // which matches Seller Hub. Orders counted by creation date in-window; pricing
      // broken into item / shipping / tax / total so any gap is fully explained.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      // Window: either an explicit range (fromDate/toDate, already UTC ISO from the
      // browser so it matches eBay Seller Hub's local calendar dates) or rolling Nd.
      const days = Math.min(+body.days || 90, 365)
      const startDate = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - days * 86400000)
      // eBay rejects future dates — cap the end at "now" (a To=today picker becomes
      // a future UTC instant once the local end-of-day is converted).
      const endDate   = new Date(Math.min((body.toDate ? new Date(body.toDate) : new Date()).getTime(), Date.now()))
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Accept': 'application/json' }

      const filter = `creationdate:[${startDate.toISOString()}..${endDate.toISOString()}]`
      let offset = 0, total = 0
      let ebayOrders = 0, ebayItems = 0, cancelled = 0
      let itemTotal = 0, shipTotal = 0, taxTotal = 0, grandTotal = 0, discTotal = 0, adjTotal = 0
      const ebayItemIds = new Set<string>()
      // Per-order line items, so we can pinpoint which exact sales we're missing
      // (an order with N line items needs N of our sold parts tagged with its id).
      const ebayByOrder: Record<string, { legacyItemId?: string, sku?: string, title?: string, price: number }[]> = {}
      // Orders whose own pricing breakdown doesn't reconcile (the unexplained $).
      const residualOrders: any[] = []
      do {
        const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
        const r = await fetch(url, { headers })
        if (!r.ok) { const t = await r.text(); throw new Error(`getOrders ${r.status}: ${t.slice(0, 300)}`) }
        const d = await r.json()
        total = +d.total || 0
        for (const o of (d.orders ?? [])) {
          const cs = o.cancelStatus?.cancelState
          if (cs && cs !== 'NONE_REQUESTED') { cancelled++; continue }
          const ps = o.pricingSummary ?? {}
          ebayOrders++
          const oSub  = +ps.priceSubtotal?.value || 0
          const oShip = +ps.deliveryCost?.value  || 0
          const oTax  = +ps.tax?.value           || 0
          const oTot  = +ps.total?.value         || 0
          const oDisc = (+ps.priceDiscount?.value || 0) + (+ps.deliveryDiscount?.value || 0)
          const oAdj  = +ps.adjustment?.value || 0
          itemTotal  += oSub
          shipTotal  += oShip
          taxTotal   += oTax
          grandTotal += oTot
          discTotal  += oDisc
          adjTotal   += oAdj
          // Per-order reconciliation: sub + ship + tax − discount + adj should equal
          // total. Anything left over is this order's contribution to "unexplained".
          const oResid = Math.round((oSub + oShip + oTax - oDisc + oAdj - oTot) * 100) / 100
          if (Math.abs(oResid) >= 0.01) {
            residualOrders.push({
              orderId: o.orderId, residual: oResid,
              subtotal: oSub, shipping: oShip, tax: oTax, discount: oDisc, adjustment: oAdj, total: oTot,
              paymentStatus: o.orderPaymentStatus, fulfillmentStatus: o.orderFulfillmentStatus,
            })
          }
          const oid = o.orderId as string
          for (const li of (o.lineItems ?? [])) {
            ebayItems += +li.quantity || 1
            if (li.legacyItemId) ebayItemIds.add(li.legacyItemId)
            ;(ebayByOrder[oid] ??= []).push({
              legacyItemId: li.legacyItemId, sku: li.sku, title: li.title,
              price: +li.lineItemCost?.value || +li.total?.value || 0,
            })
          }
        }
        offset += 200
      } while (offset < total && offset < 5000)

      // "Our" side now reads the ebay_sales mirror (the source of truth), so it
      // equals eBay's getOrders by construction once an import has run.
      const { data: ourSold } = await sb.from('ebay_sales').select('sold_price, shipping, order_id')
        .eq('store_id', storeId).eq('cancelled', false)
        .gte('sold_at', startDate.toISOString()).lte('sold_at', endDate.toISOString())
      const ourCount = (ourSold ?? []).length
      const ourItem  = (ourSold ?? []).reduce((a: number, s: any) => a + (+s.sold_price || 0), 0)
      const ourShip  = (ourSold ?? []).reduce((a: number, s: any) => a + (+s.shipping || 0), 0)

      // How many sale rows we hold per eBay order, to find under-covered orders.
      const ourByOrder: Record<string, number> = {}
      for (const s of (ourSold ?? [])) if (s.order_id) ourByOrder[s.order_id] = (ourByOrder[s.order_id] || 0) + 1
      const missingItems: any[] = []
      let missingValue = 0, missingCount = 0
      for (const [oid, items] of Object.entries(ebayByOrder)) {
        const have = ourByOrder[oid] || 0
        if (have < items.length) {
          for (const m of items.slice(have)) {
            missingCount++; missingValue += m.price
            if (missingItems.length < 50) missingItems.push({ orderId: oid, ...m })
          }
        }
      }
      const r2 = (n: number) => Math.round(n * 100) / 100

      return json({
        ok: true, version: EDGE_FN_VERSION, days, source: 'getOrders',
        windowFrom: startDate.toISOString(), windowTo: endDate.toISOString(),
        ebayOrders, ebayItems, ebayCancelled: cancelled,
        ebayItemTotal: r2(itemTotal), ebayShipping: r2(shipTotal), ebayTax: r2(taxTotal), ebayPaidTotal: r2(grandTotal),
        // Only genuine eBay-reported values. `ebayDiscount`/`ebayAdjustment` come
        // straight from the API. `ebayUnexplained` is whatever is still left over
        // after accounting for them — surfaced honestly, never folded into discount.
        ebayDiscount: r2(discTotal), ebayAdjustment: r2(adjTotal),
        ebayUnexplained: r2(itemTotal + shipTotal + taxTotal - discTotal + adjTotal - grandTotal),
        residualCount: residualOrders.length,
        residualOrders: residualOrders.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)).slice(0, 40),
        ourCount, ourItemTotal: r2(ourItem), ourShipping: r2(ourShip),
        missingSales: Math.max(0, ebayItems - ourCount),
        missingCount, missingValue: r2(missingValue), missingItems,
      })
    }

    // Order-complete sold import. Walks eBay getOrders and upserts EVERY line item
    // into the ebay_sales mirror, keyed on (store_id, order_id, line_item_id) —
    // eBay's own unique key. This is idempotent and collision-proof: a relist or
    // repeat sale of the same SKU/item produces a SEPARATE row instead of
    // overwriting. ebay_sales is the source of truth for sales revenue + fees, so
    // the Dashboard P&L and Sales-match equal eBay's getOrders exactly. We also
    // best-effort link each sale to an inventory part (for COGS) and mark a matched
    // part sold — but the sale is recorded whether or not a part match exists.
    if (action === 'import_sold_orders') {
      const days = Math.min(+body.days || 120, 365)
      const startDate = new Date(Date.now() - days * 86400000)
      const startOffset = Math.max(0, +body.startOffset || 0)
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Accept': 'application/json' }
      const filter = `creationdate:[${startDate.toISOString()}..${new Date().toISOString()}]`

      const startedAt = Date.now()
      let offset = startOffset, total = 0, upserted = 0, linked = 0, lineItems = 0, failed = 0
      const failedReasons: string[] = []
      do {
        const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
        const r = await fetch(url, { headers })
        if (!r.ok) { const t = await r.text(); throw new Error(`getOrders ${r.status}: ${t.slice(0, 300)}`) }
        const d = await r.json()
        total = +d.total || 0
        for (const o of (d.orders ?? [])) {
          const cs = o.cancelStatus?.cancelState
          const isCancelled = !!(cs && cs !== 'NONE_REQUESTED')
          const soldDate: string = o.creationDate
          const lis = o.lineItems ?? []
          const ship = +o.pricingSummary?.deliveryCost?.value || 0
          const shipPer = lis.length ? Math.round((ship / lis.length) * 100) / 100 : 0
          const orderId: string = o.orderId
          // Dispatch info: shipping state + buyer + ship-to (drives the To-send queue).
          const fulfillment: string | null = o.orderFulfillmentStatus || null
          const buyer: string | null = o.buyer?.username || null
          const shipToRaw = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo
          const shipTo = shipToRaw ? {
            name: shipToRaw.fullName || '',
            addressLine1: shipToRaw.contactAddress?.addressLine1 || '',
            addressLine2: shipToRaw.contactAddress?.addressLine2 || '',
            city: shipToRaw.contactAddress?.city || '',
            state: shipToRaw.contactAddress?.stateOrProvince || '',
            postcode: shipToRaw.contactAddress?.postalCode || '',
            country: shipToRaw.contactAddress?.countryCode || '',
            phone: shipToRaw.primaryPhone?.phoneNumber || '',
          } : null
          for (const li of lis) {
            lineItems++
            try {
              const legacyId: string | undefined = li.legacyItemId
              const sku: string | undefined = li.sku
              const lineItemId: string = li.lineItemId || legacyId || `${orderId}-${lineItems}`
              const qty = +li.quantity || 1
              const price = +li.lineItemCost?.value || +li.total?.value || 0

              // Best-effort link to an inventory part (by listing item id, then SKU).
              let partId: string | null = null
              if (legacyId) {
                const { data: lst } = await sb.from('listings').select('part_id').eq('store_id', storeId).eq('platform', 'ebay').eq('platform_listing_id', legacyId).limit(1).maybeSingle()
                if (lst) partId = lst.part_id
              }
              if (!partId && sku) {
                const { data: pr } = await sb.from('parts').select('id').eq('store_id', storeId).eq('sku', sku).maybeSingle()
                if (pr) partId = pr.id
              }

              // Upsert the authoritative sale row (collision-proof on the unique key).
              const baseRow: Record<string, unknown> = {
                store_id: storeId, order_id: orderId, line_item_id: lineItemId,
                legacy_item_id: legacyId || null, sku: sku || null, title: li.title || 'eBay sale',
                quantity: qty, sold_price: price, shipping: shipPer,
                sold_at: soldDate, cancelled: isCancelled, part_id: partId,
                updated_at: new Date().toISOString(),
              }
              let { error: upErr } = await sb.from('ebay_sales').upsert(
                { ...baseRow, fulfillment_status: fulfillment, buyer, ship_to: shipTo },
                { onConflict: 'store_id,order_id,line_item_id' })
              // Dispatch columns are additive — if their migration hasn't run yet,
              // fall back so the live sales sync never breaks.
              if (upErr && /column|schema/i.test(upErr.message || '')) {
                ({ error: upErr } = await sb.from('ebay_sales').upsert(baseRow, { onConflict: 'store_id,order_id,line_item_id' }))
              }
              if (upErr) throw upErr
              upserted++

              // Keep inventory honest: mark a matched part sold (revenue still comes
              // from ebay_sales, so a collision here only affects inventory display).
              if (partId && !isCancelled) {
                await sb.from('parts').update({ status: 'sold', sold_price: price, sold_date: soldDate, shipping_charged: shipPer, ebay_order_id: orderId }).eq('id', partId)
                linked++
              }
            } catch (e: any) {
              failed++
              if (failedReasons.length < 5) failedReasons.push(String(e?.message || e))
            }
          }
        }
        offset += 200
      } while (offset < total && offset < 5000 && Date.now() - startedAt < 45000)

      const hasMore = offset < total
      await touchLiveSync(storeId, `Live sales check · ${upserted} new`)
      // `created`/`updated` kept for backwards-compatible client display.
      return json({ ok: true, version: EDGE_FN_VERSION, days, ebayOrders: total, lineItems, upserted, linked, created: upserted, updated: linked, skipped: 0, failed, failedReasons, hasMore, nextOffset: offset })
    }

    // ── Historical sales import from an uploaded eBay Orders report (CSV) ─────────
    // The eBay APIs only reach ~90 days; the Seller Hub Orders report exports years.
    // The CLIENT parses the CSV (handles the report's quoting / summary rows / AU$
    // money / DD-Mon-YY dates) and posts batches of normalised sale rows here.
    //
    // DEDUP (per the store's "our records win" policy): the stable cross-source
    // identity of a sale line is (Order Number + Item Number). eBay represents a
    // qty>1 purchase as ONE line (a Quantity field), and the same item number selling
    // to multiple buyers shows as SEPARATE orders — so (order, item) is unique per
    // sale and works for multi-quantity / multi-category listings, not just one-off
    // parts. If we already hold a sale for that (order, item) — from the API sync OR a
    // prior CSV — the row is SKIPPED. The table's unique (store_id, order_id,
    // line_item_id) (line_item_id = the CSV Transaction ID) is the structural backstop.
    //
    // Rows are tagged source='csv_orders_report'. The Orders report has no fee
    // column, so fees = 0 (revenue-accurate, net/margin will read high on old sales).
    // We best-effort link a part by item number but NEVER change a part's status —
    // current inventory stays authoritative.
    if (action === 'import_orders_csv') {
      const rows: any[] = Array.isArray(body.rows) ? body.rows : []
      if (!rows.length) return json({ ok: true, version: EDGE_FN_VERSION, inserted: 0, linked: 0, skippedExisting: 0, skippedNoItem: 0 })

      // Normalise; drop rows without an item number (order-summary lines have none).
      const clean = rows
        .map(r => ({
          orderId:    String(r.orderId || '').trim(),
          lineItemId: String(r.lineItemId || r.itemNumber || '').trim(),
          itemNumber: String(r.itemNumber || '').trim(),
          title:      String(r.title || 'eBay sale').trim() || 'eBay sale',
          sku:        r.sku ? String(r.sku).trim() : null,
          quantity:   Math.max(1, Math.floor(+r.quantity || 1)),
          soldPrice:  +r.soldPrice || 0,
          shipping:   +r.shipping || 0,
          soldAt:     r.soldAt || null,
        }))
        .filter(r => r.itemNumber)
      const skippedNoItem = rows.length - clean.length

      // CRITICAL: only import sales OLDER than eBay's getOrders reach (~90 days).
      // Anything newer is owned by the live sync, which re-imports it nightly WITH
      // fees/refunds — importing it from the CSV would create a fee-less record that
      // either blocks enrichment or (if the CSV transaction id ≠ the API line-item id)
      // becomes a duplicate the sync can't reconcile. eBay never returns orders older
      // than this window, so CSV rows below the cutoff can never collide with a future
      // sync — making this safe regardless of whether a sync has run. Rows with an
      // unparseable date are kept (they're almost always old history).
      const cutoffMs = Date.now() - API_WINDOW_DAYS * 86400000
      const eligible = clean.filter(r => !r.soldAt || new Date(r.soldAt).getTime() < cutoffMs)
      const skippedRecent = clean.length - eligible.length
      if (!eligible.length) return json({ ok: true, version: EDGE_FN_VERSION, inserted: 0, linked: 0, skippedExisting: 0, skippedRecent, skippedNoItem })

      const itemNumbers = [...new Set(eligible.map(r => r.itemNumber))]

      // Sales we already hold, keyed (order_id|item_number) — the stable cross-source
      // identity. Skip those (existing records win). Querying by item number uses the
      // (store_id, legacy_item_id) index; the composite match then allows the SAME
      // item number to legitimately sell across multiple orders (multi-qty / GTC).
      const existing = new Set<string>()
      for (let i = 0; i < itemNumbers.length; i += 300) {
        const slice = itemNumbers.slice(i, i + 300)
        const { data } = await sb.from('ebay_sales').select('order_id, legacy_item_id')
          .eq('store_id', storeId).in('legacy_item_id', slice)
        ;(data ?? []).forEach((d: any) => { if (d.legacy_item_id) existing.add(`${d.order_id}|${d.legacy_item_id}`) })
      }

      // Best-effort part link by item number (read-only; never flips part status).
      const partByItem = new Map<string, string>()
      for (let i = 0; i < itemNumbers.length; i += 300) {
        const slice = itemNumbers.slice(i, i + 300)
        const { data } = await sb.from('listings').select('platform_listing_id, part_id')
          .eq('store_id', storeId).eq('platform', 'ebay').in('platform_listing_id', slice)
        ;(data ?? []).forEach((l: any) => { if (l.platform_listing_id && l.part_id) partByItem.set(l.platform_listing_id, l.part_id) })
      }

      const toInsert = eligible
        .filter(r => !existing.has(`${r.orderId || r.itemNumber}|${r.itemNumber}`))
        .map(r => ({
          store_id:       storeId,
          order_id:       r.orderId || r.itemNumber,
          line_item_id:   r.lineItemId || r.itemNumber,
          legacy_item_id: r.itemNumber,
          sku:            r.sku,
          title:          r.title,
          quantity:       r.quantity,
          sold_price:     r.soldPrice,
          shipping:       r.shipping,
          fees:           0,
          sold_at:        r.soldAt,
          cancelled:      false,
          part_id:        partByItem.get(r.itemNumber) || null,
          source:         'csv_orders_report',
          updated_at:     new Date().toISOString(),
        }))

      let inserted = 0, linked = 0
      for (let i = 0; i < toInsert.length; i += 200) {
        const slice = toInsert.slice(i, i + 200)
        const { error } = await sb.from('ebay_sales')
          .upsert(slice, { onConflict: 'store_id,order_id,line_item_id', ignoreDuplicates: true })
        if (error) throw new Error(`csv import: ${error.message}`)
        inserted += slice.length
        linked += slice.filter(s => s.part_id).length
      }

      return json({
        ok: true, version: EDGE_FN_VERSION,
        inserted, linked, skippedExisting: eligible.length - toInsert.length, skippedRecent, skippedNoItem,
      })
    }

    // Apply the historical cost MODEL (value-scaling % + fixed flats, computed
    // client-side from the last 90 days of real sales) to every imported sale, then
    // LOCK so figures can't drift as the rolling average moves. Each row's cost is
    // price-dependent, so the bulk per-row write is done in one SQL statement via the
    // apply_historical_costs() function. Refuses if already locked unless force=true.
    if (action === 'apply_historical_costs') {
      const m = body.model || {}
      const now = new Date().toISOString()
      const { data: store } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = store?.settings || {}
      if (settings.historicalCostLock?.locked && !body.force) {
        return json({ error: 'Historical costs are locked. Unlock first to recompute.' }, 409)
      }
      const { data: applied, error: rpcErr } = await sb.rpc('apply_historical_costs', {
        p_store: storeId,
        p_purchase_pct: +m.purchase_pct || 0,
        p_listing_pct:  +m.listing_pct || 0,
        p_promo_pct:    +m.promo_pct || 0,
        p_postage:      +m.postage || 0,
        p_storage:      +m.storage || 0,
        p_admin:        +m.admin || 0,
        p_labour:       +m.labour || 0,
      })
      if (rpcErr) throw new Error(`apply costs: ${rpcErr.message}`)
      const newSettings = { ...settings, historicalCostLock: { locked: true, computedAt: now, model: m } }
      await sb.from('stores').update({ settings: newSettings }).eq('id', storeId)
      return json({ ok: true, version: EDGE_FN_VERSION, applied: applied || 0, computedAt: now, model: m })
    }

    // Lift the lock so the costs can be recomputed. The client warns that this can
    // change historical figures that may already have been used in financials.
    if (action === 'unlock_historical_costs') {
      const { data: store } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = store?.settings || {}
      const lock = settings.historicalCostLock || {}
      const newSettings = { ...settings, historicalCostLock: { ...lock, locked: false, unlockedAt: new Date().toISOString() } }
      await sb.from('stores').update({ settings: newSettings }).eq('id', storeId)
      return json({ ok: true, version: EDGE_FN_VERSION, locked: false })
    }

    // eBay selling fees from the Finances API (the ledger eBay's reports are built
    // from). Sums each SALE transaction's total fee per order, then attributes it to
    // that order's part(s) (split by sale price) into costs->>'ebay_fees'. This is
    // what makes net sales / margins match eBay's report — fees are ~24% of sales.
    if (action === 'import_fees') {
      const days = Math.min(+body.days || 120, 365)
      // Explicit fromDate/toDate (used by the full-history fee backfill, which loops
      // 90-day windows) overrides the rolling `days` window. eBay's getTransactions
      // accepts ~90-day ranges, so callers window accordingly.
      const startDate = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - days * 86400000)
      const endDate   = body.toDate   ? new Date(body.toDate)   : new Date()
      const { token } = await getToken()
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Accept': 'application/json' }
      const dateRange = `transactionDate:[${startDate.toISOString()}..${endDate.toISOString()}]`

      const startedAt = Date.now()
      const feeByOrder: Record<string, number> = {}
      const feeDetailByOrder: Record<string, Record<string, number>> = {} // oid → { FEE_TYPE: amount }
      const refundByOrder: Record<string, number> = {}
      const shipByOrder: Record<string, number> = {}
      let saleFees = 0, otherFees = 0, unattributed = 0, refundTotalAll = 0, shipCostAll = 0

      // Resolve an order id from a transaction: direct field, else its references.
      const orderIdOf = (tx: any): string | undefined =>
        tx.orderId || (tx.references ?? []).find((r: any) => r.referenceType === 'ORDER_ID')?.referenceId

      // eBay's money ledger across four transaction types:
      //   SALE            — final value fee + fixed/intl/regulatory (a cost)
      //   NON_SALE_CHARGE — promoted-listing & other charges (a cost)
      //   REFUND          — money returned to the buyer (reverses revenue)
      //   SHIPPING_LABEL  — label we bought through eBay (a real shipping cost)
      for (const txType of ['SALE', 'NON_SALE_CHARGE', 'REFUND', 'SHIPPING_LABEL']) {
        const filter = `${dateRange},transactionType:{${txType}}`
        let offset = 0, total = 0
        do {
          const url = `https://apiz.ebay.com/sell/finances/v1/transaction?filter=${encodeURIComponent(filter)}&limit=200&offset=${offset}`
          let r = await fetch(url, { headers })
          // The eBay Finances API throws intermittent 5xx (errorId 135000, "eBay
          // internal system problem") — retry a few times before giving up.
          for (let attempt = 0; !r.ok && (r.status >= 500 || r.status === 429) && attempt < 3; attempt++) {
            await new Promise(res => setTimeout(res, 800 * (attempt + 1)))
            r = await fetch(url, { headers })
          }
          if (!r.ok) { const t = await r.text(); throw new Error(`getTransactions ${r.status}: ${t.slice(0, 300)}`) }
          const d = await r.json()
          total = +d.total || 0
          for (const tx of (d.transactions ?? [])) {
            const oid = orderIdOf(tx)
            const amt = +tx.amount?.value || 0
            if (txType === 'SALE') {
              const fee = +tx.totalFeeAmount?.value || 0
              if (!fee) continue
              saleFees += fee
              if (oid) {
                feeByOrder[oid] = (feeByOrder[oid] || 0) + fee
                // Per-type detail from the line items (sums to totalFeeAmount).
                const det = feeDetailByOrder[oid] || (feeDetailByOrder[oid] = {})
                let lineSum = 0
                for (const li of (tx.orderLineItems ?? [])) {
                  for (const mf of (li.marketplaceFees ?? [])) {
                    const a = +mf.amount?.value || 0
                    if (!a) continue
                    const ft = mf.feeType || 'FINAL_VALUE_FEE'
                    det[ft] = (det[ft] || 0) + a; lineSum += a
                  }
                }
                const rem = Math.round((fee - lineSum) * 100) / 100   // any unbroken-down remainder
                if (Math.abs(rem) > 0.005) det.FINAL_VALUE_FEE = (det.FINAL_VALUE_FEE || 0) + rem
              } else unattributed += fee
              // A SALE that was refunded usually credits the final value fee back
              // here as a negative — that nets into feeByOrder automatically.
            } else if (txType === 'NON_SALE_CHARGE') {
              if (!amt) continue
              otherFees += amt
              if (oid) {
                feeByOrder[oid] = (feeByOrder[oid] || 0) + amt
                const det = feeDetailByOrder[oid] || (feeDetailByOrder[oid] = {})
                det.PROMOTION = (det.PROMOTION || 0) + amt
              } else unattributed += amt
            } else if (txType === 'REFUND') {
              if (!amt) continue
              refundTotalAll += amt
              if (oid) refundByOrder[oid] = (refundByOrder[oid] || 0) + amt
            } else if (txType === 'SHIPPING_LABEL') {
              if (!amt) continue
              shipCostAll += amt
              if (oid) shipByOrder[oid] = (shipByOrder[oid] || 0) + amt
            }
          }
          offset += 200
        } while (offset < total && offset < 5000 && Date.now() - startedAt < 60000)
      }

      // dryRun: callers that only need the FVF-vs-promotion split (the historical-cost
      // backfill) read the totals without writing anything back to ebay_sales.
      if (body.dryRun) {
        const r2d = (n: number) => Math.round(n * 100) / 100
        return json({ ok: true, version: EDGE_FN_VERSION, days, dryRun: true,
          saleFees: r2d(saleFees), otherFees: r2d(otherFees), feeTotal: r2d(saleFees + otherFees) })
      }

      // Attribute fee / refund / shipping-cost onto each order's ebay_sales line(s),
      // split by sale price. ebay_sales is the source of truth for the Dashboard P&L.
      const allOrderIds = new Set([...Object.keys(feeByOrder), ...Object.keys(refundByOrder), ...Object.keys(shipByOrder)])
      let updated = 0, ordersMatched = 0, feeTotal = 0
      for (const oid of allOrderIds) {
        const fee    = feeByOrder[oid]    || 0
        const refund = refundByOrder[oid] || 0
        const ship   = shipByOrder[oid]   || 0
        feeTotal += fee
        const { data: sales } = await sb.from('ebay_sales').select('id, sold_price')
          .eq('store_id', storeId).eq('order_id', oid)
        if (!sales?.length) continue
        ordersMatched++
        const totalVal = sales.reduce((a: number, s: any) => a + (+s.sold_price || 0), 0)
        const r2x = (n: number) => Math.round(n * 100) / 100
        const det = feeDetailByOrder[oid] || null
        for (const s of sales) {
          const frac = totalVal > 0 ? (+s.sold_price || 0) / totalVal : 1 / sales.length
          const feeDetailRow = det
            ? Object.fromEntries(Object.entries(det).map(([k, v]) => [k, r2x(v * frac)]).filter(([, v]) => Math.abs(+v) > 0.005))
            : null
          await sb.from('ebay_sales').update({
            fees: r2x(fee * frac),
            refund: r2x(refund * frac),
            ship_cost: r2x(ship * frac),
            refunded: refund > 0,
            fee_detail: feeDetailRow,
            updated_at: new Date().toISOString(),
          }).eq('id', s.id)
          updated++
        }
        if (Date.now() - startedAt > 110000) break
      }

      const r2 = (n: number) => Math.round(n * 100) / 100
      return json({ ok: true, version: EDGE_FN_VERSION, days,
        feeTotal: r2(feeTotal), saleFees: r2(saleFees), otherFees: r2(otherFees), unattributed: r2(unattributed),
        refundTotal: r2(refundTotalAll), shipCostTotal: r2(shipCostAll),
        ordersWithFees: Object.keys(feeByOrder).length, ordersMatched, updated })
    }

    if (action === 'sync_status') {
      // Lightweight sync-health check: how many parts are out of step with eBay.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      const { token, certId } = await getToken()
      const ebayIds = await fetchAllIds(token, certId, 'ActiveList')
      const ebaySet = new Set(ebayIds)
      const { data: activeListings } = await sb.from('listings').select('platform_listing_id')
        .eq('store_id', storeId).eq('platform', 'ebay').in('status', ['active', 'live']).not('deferred_review', 'is', true).is('deleted_at', null)
      const { data: allListings } = await sb.from('listings').select('platform_listing_id')
        .eq('store_id', storeId).eq('platform', 'ebay').is('deleted_at', null)
      const ourIds = new Set((allListings ?? []).map((l: any) => l.platform_listing_id))
      const ourActive = (activeListings ?? []).map((l: any) => l.platform_listing_id)
      const stale = ourActive.filter((id: string) => !ebaySet.has(id)).length   // listed here, gone from eBay
      const missing = ebayIds.filter((id: string) => !ourIds.has(id)).length     // on eBay, not here
      // Diagnostic: how our eBay listings break down by status (why pvActive may be 0).
      const { data: allRows } = await sb.from('listings').select('status').eq('store_id', storeId).eq('platform', 'ebay').is('deleted_at', null)
      const statusBreakdown: Record<string, number> = {}
      for (const l of (allRows ?? [])) statusBreakdown[l.status || 'null'] = (statusBreakdown[l.status || 'null'] || 0) + 1
      return json({ ok: true, version: EDGE_FN_VERSION, ebayActive: ebayIds.length, pvActive: ourActive.length, stale, missing, outOfSync: stale + missing, statusBreakdown, checkedAt: new Date().toISOString() })
    }

    // TEMP DEBUG: for a list of item IDs, report whether GetSellerList (the recent
    // supplement) returns them, and what GetItem says. Read-only. Used to diagnose
    // why specific active listings aren't importing. Safe to remove later.
    if (action === 'debug_listings') {
      const { token, certId } = await getToken()
      const ids: string[] = body.itemIds ?? []
      const recent = await fetchRecentlyListedIds(token, certId, 30)
      const recentSet = new Set(recent)
      const perId: any[] = []
      for (const id of ids) {
        let gi: Record<string, unknown> = {}
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${id}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`)
          gi = {
            ack: getTag(xml, 'Ack'), listingStatus: getTag(xml, 'ListingStatus'),
            sellingState: getTag(xml, 'SellingState'), sku: getTag(xml, 'SKU'),
            title: getTag(xml, 'Title').slice(0, 60), error: getTag(xml, 'LongMessage'),
          }
        } catch (e) { gi = { ack: 'FETCH_ERROR', error: (e as Error).message } }
        perId.push({ id, inGetSellerList30d: recentSet.has(id), getItem: gi })
      }
      return json({ ok: true, version: EDGE_FN_VERSION, getSellerListCount: recent.length, perId })
    }

    // Lightweight, frequent "catch new listings" check (pg_cron calls this every
    // 5 min). One GetSellerList call over a short window; imports ONLY listings not
    // already in the DB, reusing the same collision-proof import path via a job +
    // process_chunk self-calls. Read-only on eBay, purely additive in our DB, and
    // a no-op (1 API call) when nothing new has been listed.
    if (action === 'import_recent') {
      const days = Math.min(+body.days || 3, 30)
      const { token, certId } = await getToken()
      const recent = await fetchRecentlyListedIds(token, certId, days)
      if (!recent.length) return json({ ok: true, version: EDGE_FN_VERSION, checked: 0, missing: 0, imported: 0 })

      const { data: have } = await sb.from('listings').select('platform_listing_id')
        .eq('store_id', storeId).eq('platform', 'ebay').in('platform_listing_id', recent)
      const haveSet = new Set((have ?? []).map((l: any) => l.platform_listing_id))
      const missing = recent.filter(id => !haveSet.has(id))
      if (!missing.length) return json({ ok: true, version: EDGE_FN_VERSION, checked: recent.length, missing: 0, imported: 0 })

      const { data: job, error: jobErr } = await sb.from('jobs').insert({
        store_id: storeId, type: 'ebay_import', status: 'running',
        total_items: missing.length, current_item: 'Importing new listings…',
        started_at: new Date().toISOString(),
        meta: { all_item_ids: missing, batch_offset: 0, failed_reasons: {} },
      }).select('id').single()
      if (jobErr) throw new Error(`Failed to create job: ${jobErr.message}`)

      // Drive the existing chunk processor to completion (few items, fast).
      const SELF_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ebay-import`
      let imported = 0, failed = 0, guard = 0
      while (guard++ < 50) {
        const r = await fetch(SELF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('SUPABASE_ANON_KEY')! },
          body: JSON.stringify({ action: 'process_chunk', jobId: job.id, storeId }),
        })
        const c = await r.json()
        if (c.error && c.retry) continue
        if (c.error) throw new Error(c.error)
        imported = c.imported ?? imported
        failed   = c.failed ?? failed
        if (c.isComplete || c.status === 'completed') break
      }
      await touchLiveSync(storeId, `Live listings check · ${imported} new`)
      return json({ ok: true, version: EDGE_FN_VERSION, checked: recent.length, missing: missing.length, imported, failed })
    }

    // Fill blank make/model (and a missing year) from the part title — one bounded,
    // local pass per call (no eBay calls). Runs as a sync phase so every sync keeps
    // the catalogue's vehicle fields current; newest parts first.
    if (action === 'parse_titles') {
      const mkt = await storeMarketplace(sb, storeId) // regional aliases (Chevy↔Holden)
      const { data: parts } = await sb.from('parts')
        .select('id, title, make, model, year')
        .eq('store_id', storeId).is('deleted_at', null)
        .or('make.is.null,make.eq.,model.is.null,model.eq.')
        .order('created_at', { ascending: false })
        .limit(500)
      const updates: Array<{ id: string; patch: any }> = []
      for (const p of (parts ?? [])) {
        const blankMake = !(p.make || '').trim(), blankModel = !(p.model || '').trim()
        if (!blankMake && !blankModel) continue
        const v = parseVehicle(p.title || '', mkt.mp)
        const patch: any = {}
        if (blankMake && v.make) patch.make = v.make
        if (blankModel && v.model) patch.model = v.model
        if (!(p.year || '').trim() && v.year) patch.year = v.year
        if (Object.keys(patch).length) updates.push({ id: p.id, patch })
      }
      let updated = 0
      for (let i = 0; i < updates.length; i += 25) {
        await Promise.all(updates.slice(i, i + 25).map(({ id, patch }) =>
          sb.from('parts').update(patch).eq('id', id).then(({ error }: any) => { if (!error) updated++ })))
      }
      return json({ ok: true, version: EDGE_FN_VERSION, scanned: (parts ?? []).length, updated })
    }

    if (action === 'reconcile') {
      const { token, certId } = await getToken()
      const ebayIds = await fetchAllIds(token, certId, 'ActiveList')
      const ebaySet = new Set(ebayIds)

      const { data: activeListings } = await sb.from('listings')
        .select('id, part_id, platform_listing_id, platform_sku')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .in('status', ['active', 'live'])
        .not('deferred_review', 'is', true)
        .is('deleted_at', null)

      const { data: allListings } = await sb.from('listings')
        .select('platform_listing_id')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .is('deleted_at', null)

      const ourIds     = new Set((allListings ?? []).map((l: any) => l.platform_listing_id))
      const missingIds = ebayIds.filter(id => !ourIds.has(id))
      const stale      = (activeListings ?? []).filter((l: any) => !ebaySet.has(l.platform_listing_id))

      if (stale.length > 0) {
        await sb.from('listings')
          .update({ reconcile_flagged: true, reconcile_flagged_at: new Date().toISOString() })
          .in('id', stale.map((l: any) => l.id))
      }

      // Auto-resolve clear-cut stale items: GetItem-classify, then apply —
      //   sold → listing+part 'sold';
      //   ended-unsold / not-found → listing 'ended' + part back to 'in_stock';
      //   still active on eBay (false positive) → just clear the flag.
      // Ambiguous or errored items stay flagged for manual review. Bounded by time +
      // count so a big backlog clears over a few runs instead of timing out.
      let autoSold = 0, autoEnded = 0, autoKept = 0, autoErr = 0
      const resolvedIds = new Set<string>()
      const arStart = Date.now()
      for (const l of (stale as any[])) {
        if (Date.now() - arStart > 45000 || (autoSold + autoEnded + autoKept) >= 150) break
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${l.platform_listing_id}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics></GetItemRequest>`)
          const ack = getTag(xml, 'Ack'), errCode = getTag(xml, 'ErrorCode'), longMsg = (getTag(xml, 'LongMessage') || '').toLowerCase()
          const notFound = errCode === '17' || errCode === '291' || (ack === 'Failure' && longMsg.includes('not found'))
          if (ack === 'Failure' && !notFound) { autoErr++; continue }   // transient/error → leave flagged
          const sellingState = getTag(xml, 'SellingState'), listingStatus = getTag(xml, 'ListingStatus')
          if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
            const salePrice = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || null
            const soldDate  = getTag(xml, 'PaidTime') || getTag(xml, 'EndTime') || null
            await sb.from('listings').update({ status: 'sold', sold_price: salePrice, sold_at: soldDate, reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', l.id)
            if (l.part_id) await sb.from('parts').update({ status: 'sold', ...(salePrice ? { sold_price: salePrice } : {}), ...(soldDate ? { sold_date: soldDate } : {}) }).eq('id', l.part_id)
            autoSold++; resolvedIds.add(l.id)
          } else if (!notFound && (listingStatus === 'Active' || sellingState === 'Active')) {
            await sb.from('listings').update({ reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', l.id)
            autoKept++; resolvedIds.add(l.id)
          } else {  // Ended unsold (or not found on eBay) → part returns to stock
            await sb.from('listings').update({ status: 'ended', reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', l.id)
            if (l.part_id) await sb.from('parts').update({ status: 'in_stock' }).eq('id', l.part_id)
            autoEnded++; resolvedIds.add(l.id)
          }
        } catch { autoErr++ }
      }
      const remainingStale = (stale as any[]).filter(l => !resolvedIds.has(l.id))

      const { data: lastJob } = await sb.from('jobs')
        .select('id, meta, failed_items')
        .eq('store_id', storeId)
        .eq('type', 'ebay_import')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const failedReasons: Record<string, string> = lastJob?.meta?.failed_reasons ?? {}

      return json({
        ebayActiveCount: ebayIds.length,
        pvActiveCount:   (activeListings ?? []).length,
        missingCount:    missingIds.length,
        missingIds:      missingIds.slice(0, 50),
        autoResolved:    { sold: autoSold, ended: autoEnded, keptActive: autoKept, errors: autoErr },
        staleCount:      remainingStale.length,
        staleListings:   remainingStale.slice(0, 50).map((l: any) => ({
          id:                l.id,
          partId:            l.part_id,
          platformListingId: l.platform_listing_id,
          platformSku:       l.platform_sku,
        })),
        failedCount:  Object.keys(failedReasons).length,
        failedItems:  Object.entries(failedReasons).map(([itemId, reason]) => ({ itemId, reason })),
        lastJobId:    lastJob?.id ?? null,
        reconciledAt: new Date().toISOString(),
      })
    }

    if (action === 'enrich_stale') {
      const { token, certId } = await getToken()
      const ids: string[] = body.itemIds ?? []
      if (!ids.length) throw new Error('No item IDs provided')

      const enriched: any[] = []

      for (const itemId of ids) {
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics>
</GetItemRequest>`)

          const ack     = getTag(xml, 'Ack')
          const errCode = getTag(xml, 'ErrorCode')
          const longMsg = getTag(xml, 'LongMessage')

          if (errCode === '17' || errCode === '291' || (ack === 'Failure' && longMsg.toLowerCase().includes('not found'))) {
            enriched.push({ itemId, ebayStatus: 'NotFound' }); continue
          }
          if (ack === 'Failure') {
            enriched.push({ itemId, ebayStatus: 'Error', error: longMsg }); continue
          }

          const sellingState  = getTag(xml, 'SellingState')
          const listingStatus = getTag(xml, 'ListingStatus')
          const endTime       = getTag(xml, 'EndTime')

          let ebayStatus = 'Ended'
          let salePrice: number | undefined
          let soldDate: string | undefined

          if (sellingState === 'EndedWithSales' || sellingState === 'Sold') {
            ebayStatus = 'Sold'
            salePrice  = parseFloat(getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'CurrentPrice')) || undefined
            soldDate   = getTag(xml, 'PaidTime') || endTime
          } else if (listingStatus === 'Active' || sellingState === 'Active') {
            ebayStatus = 'Active'
          }

          enriched.push({
            itemId, ebayStatus,
            endDate:        endTime || undefined,
            salePrice,      soldDate,
            relistedItemId: getTag(xml, 'RelistedItemID') || undefined,
          })
        } catch (e: any) {
          enriched.push({ itemId, ebayStatus: 'Error', error: e.message })
        }
      }

      return json({ enriched })
    }

    if (action === 'apply_stale_resolution') {
      const resolutions: Array<{
        listingId:  string
        partId:     string
        resolution: 'sold' | 'ended' | 'defer' | 'keep_active'
        salePrice?: number
        soldDate?:  string
      }> = body.resolutions ?? []

      if (!resolutions.length) throw new Error('No resolutions provided')

      let updated = 0
      const errors: Record<string, string> = {}

      for (const r of resolutions) {
        try {
          if (r.resolution === 'defer') {
            await sb.from('listings').update({ deferred_review: true, reconcile_flagged: false }).eq('id', r.listingId)
            updated++; continue
          }
          if (r.resolution === 'keep_active') {
            await sb.from('listings').update({ reconcile_flagged: false, reconcile_flagged_at: null }).eq('id', r.listingId)
            updated++; continue
          }

          const listingUpdate: any = { reconcile_flagged: false, reconcile_flagged_at: null }
          const partUpdate: any    = {}

          if (r.resolution === 'sold') {
            listingUpdate.status     = 'sold'
            listingUpdate.sold_price = r.salePrice ?? null
            listingUpdate.sold_at    = r.soldDate ?? null
            partUpdate.status        = 'sold'
            if (r.salePrice !== undefined) partUpdate.sold_price = r.salePrice
            if (r.soldDate)               partUpdate.sold_date  = r.soldDate
          } else if (r.resolution === 'ended') {
            listingUpdate.status = 'ended'
          }

          await sb.from('listings').update(listingUpdate).eq('id', r.listingId)
          if (Object.keys(partUpdate).length) {
            await sb.from('parts').update(partUpdate).eq('id', r.partId)
          }
          updated++
        } catch (e: any) {
          errors[r.listingId] = e.message
        }
      }

      return json({ updated, errors })
    }

    if (action === 'retry') {
      const { token, certId } = await getToken()
      const ids: string[] = body.retryIds ?? []
      if (!ids.length) throw new Error('No retry IDs provided')

      let imported = 0
      let failed   = 0
      const failedReasons: Record<string, string> = {}

      for (const itemId of ids) {
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)

          if (!xml.includes('<Ack>Success</Ack>') && !xml.includes('<Ack>Warning</Ack>')) {
            throw new Error(getTag(xml, 'LongMessage') || 'eBay API error')
          }

          const { data: existingListing } = await sb.from('listings')
            .select('id').eq('store_id', storeId).eq('platform', 'ebay').eq('platform_listing_id', itemId).maybeSingle()
          if (existingListing) { imported++; continue }

          const ebaySkuRaw = getTag(xml, 'SKU')
          let partId: string

          // Each live eBay listing is its own part: reuse on relist (SKU match,
          // no other live listing), else split concurrent same-SKU dupes into a
          // new part under a fresh internal SKU. (Mirrors the chunk-import rule.)
          const mkPart = async (sku: string) => {
            const { data: np, error: pErr } = await sb.from('parts').insert(buildPartRow(xml, sku)).select('id').single()
            if (pErr) throw pErr
            return np.id as string
          }
          const newSku = async () => {
            const { data: g, error: e } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
            if (e || !g) throw new Error(`SKU generation failed: ${e?.message}`)
            return g as string
          }

          if (ebaySkuRaw) {
            const { data: existingPart } = await sb.from('parts')
              .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).maybeSingle()
            if (existingPart) {
              const { data: liveOther } = await sb.from('listings')
                .select('id').eq('store_id', storeId).eq('platform', 'ebay').eq('part_id', existingPart.id)
                .in('status', ['active', 'live']).neq('platform_listing_id', itemId).is('deleted_at', null)
                .limit(1).maybeSingle()
              partId = liveOther ? await mkPart(await newSku()) : existingPart.id
            } else {
              partId = await mkPart(ebaySkuRaw)
            }
          } else {
            partId = await mkPart(await newSku())
          }

          const { error: listingErr } = await sb.from('listings').insert(buildListingRow(xml, partId))
          if (listingErr) throw listingErr
          await syncPhotosForPart(xml, partId)
          imported++
        } catch (e: any) {
          failed++
          failedReasons[itemId] = e.message
        }
      }

      const { data: lastJob } = await sb.from('jobs')
        .select('id, meta, failed_items')
        .eq('store_id', storeId)
        .eq('type', 'ebay_import')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (lastJob) {
        const updatedReasons = { ...(lastJob.meta?.failed_reasons ?? {}) }
        for (const id of ids) {
          if (failedReasons[id]) updatedReasons[id] = failedReasons[id]
          else delete updatedReasons[id]
        }
        await sb.from('jobs').update({
          failed_items: Object.keys(updatedReasons).length,
          meta:         { ...lastJob.meta, failed_reasons: updatedReasons },
        }).eq('id', lastJob.id)
      }

      return json({ imported, failed, failedReasons })
    }

    if (action === 'backfill_categories') {
      const startTime = Date.now()

      const { data: uncategorised } = await sb
        .from('parts')
        .select('id')
        .eq('store_id', storeId)
        .or('category.is.null,category.eq.')
        .is('deleted_at', null)

      if (!uncategorised?.length) return json({ updated: 0, noData: 0, hasMore: false })

      const uncategorisedIds = uncategorised.map((p: any) => p.id)

      // Pull CategoryID from platform_data already stored in listings table
      const partToCategoryId: Record<string, string> = {}
      for (let i = 0; i < uncategorisedIds.length; i += 200) {
        const chunk = uncategorisedIds.slice(i, i + 200)
        const { data: listings } = await sb
          .from('listings')
          .select('part_id, platform_data')
          .eq('store_id', storeId)
          .eq('platform', 'ebay')
          .in('part_id', chunk)
        for (const l of (listings || [])) {
          const catId = l.platform_data?.CategoryID?.toString()
          if (catId && !partToCategoryId[l.part_id]) partToCategoryId[l.part_id] = catId
        }
      }

      // Group by mapped category and batch update
      const categoryGroups: Record<string, string[]> = {}
      let noData = 0
      for (const partId of uncategorisedIds) {
        const catId   = partToCategoryId[partId]
        const category = catId && CATEGORY_ID_MAP[catId]
        if (!category) { noData++; continue }
        if (!categoryGroups[category]) categoryGroups[category] = []
        categoryGroups[category].push(partId)
      }

      let updated = 0
      for (const [category, partIds] of Object.entries(categoryGroups)) {
        if (Date.now() - startTime > 20000) {
          return json({ updated, noData, hasMore: true })
        }
        for (let j = 0; j < partIds.length; j += 500) {
          await sb.from('parts').update({ category }).in('id', partIds.slice(j, j + 500))
          updated += Math.min(500, partIds.length - j)
        }
      }

      return json({ updated, noData, hasMore: false })
    }

    // Resolve the store's eBay merchant (ship-from) location. eBay's Inventory API
    // won't accept a listing without one. If eBay has none registered yet, create
    // PARTVAULT_MAIN from the store's SAVED ship-from address (settings.shipAddress)
    // so a first-time list doesn't dead-end at "no inventory location". Returns the
    // key, or null when there's no saved address to create one from.
    const ensureMerchantLocation = async (ebayHeaders: Record<string, string>, existingKey: string | undefined): Promise<string | null> => {
      if (existingKey) return existingKey
      const { data: sRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const a = sRow?.settings?.shipAddress
      if (!(a && a.addressLine1 && a.city && a.postalCode && a.country)) return null
      const key = 'PARTVAULT_MAIN'
      const exist = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${key}`, { headers: ebayHeaders })
      if (exist.ok) return key
      const payload = {
        location: { address: { addressLine1: a.addressLine1, city: a.city, stateOrProvince: a.stateOrProvince || '', postalCode: a.postalCode, country: String(a.country).toUpperCase() } },
        name: 'PartVault Main', merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'],
      }
      const res = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${key}`, { method: 'POST', headers: ebayHeaders, body: JSON.stringify(payload) })
      if (res.ok || res.status === 204) return key
      const e = await res.json().catch(() => ({}))
      throw new Error(`Could not create your eBay ship-from location from the saved address (${e.errors?.[0]?.message || res.status}). Check Settings → eBay Inventory Location.`)
    }

    if (action === 'create_draft_listings') {
      const { token } = await getToken()
      const partIds: string[] = body.partIds ?? []
      if (!partIds.length) throw new Error('No part IDs provided')

      const { data: parts, error: partsErr } = await sb
        .from('parts')
        .select('*')
        .in('id', partIds)
        .eq('store_id', storeId)
      if (partsErr) throw partsErr
      if (!parts?.length) throw new Error('No parts found')

      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mkt.lang,
        'Content-Language': mkt.lang,
        'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }

      // Fetch account policies and location (use first of each)
      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])

      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      const merchantLocationKey = await ensureMerchantLocation(ebayHeaders, locData.locations?.[0]?.merchantLocationKey)
      if (!merchantLocationKey) throw new Error('No ship-from address saved — add it in Settings → eBay Inventory Location, then list again (it is created on eBay automatically).')

      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT',
        'Used – Good':      'USED_EXCELLENT',
        'Used – Fair':      'USED_EXCELLENT',
        'For Parts Only':   'FOR_PARTS_OR_NOT_WORKING',
        'Refurbished':      'SELLER_REFURBISHED',
      }

      // Resolved per the store's marketplace (category_maps; AU fallback).
      const CATEGORY_ID = await categoryMapFor(sb, mkt.mp)

      let drafted = 0
      let failed  = 0
      const errors: any[] = []

      for (const part of parts) {
        try {
          // Blocking SKU gate: nothing reaches eBay without a valid SKU. If the
          // part has none, mint one from the store's format and persist it.
          let sku = part.sku
          if (!sku || !String(sku).trim()) {
            const { data: gen, error: genErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: part.make || null })
            if (genErr || !gen) throw new Error(`Cannot create eBay draft without a SKU (auto-generation failed: ${genErr?.message || 'no SKU returned'})`)
            sku = gen as string
            await sb.from('parts').update({ sku }).eq('id', part.id)
          }
          const condition   = CONDITION_MAP[part.condition] || 'USED_GOOD'
          const categoryId  = CATEGORY_ID[part.category]   || '9886'
          const imageUrls   = (part.photos || []).map((p: any) => p.url || p.ebay_url).filter(Boolean).slice(0, 12)

          const aspects: Record<string, string[]> = {}
          if (part.make)  aspects['Make']  = [part.make]
          if (part.model) aspects['Model'] = [part.model]
          if (part.year)  aspects['Year']  = [String(part.year)]

          // 1. Create inventory item
          const invRes = await fetch(
            `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
            {
              method: 'PUT',
              headers: ebayHeaders,
              body: JSON.stringify({
                product: {
                  title: part.title,
                  description: part.notes || part.title,
                  aspects,
                  ...(imageUrls.length ? { imageUrls } : {}),
                },
                condition,
                availability: { shipToLocationAvailability: { quantity: 1 } },
              }),
            }
          )
          if (!invRes.ok && invRes.status !== 204) {
            const errText = await invRes.text()
            console.error(`Inventory item ${invRes.status} for ${sku}:`, errText)
            throw new Error(`Inventory item ${invRes.status}: ${errText.slice(0, 300)}`)
          }

          // 2. Create offer (UNPUBLISHED by default — publishOffer never called)
          const offerRes = await fetch('https://api.ebay.com/sell/inventory/v1/offer', {
            method: 'POST',
            headers: ebayHeaders,
            body: JSON.stringify({
              sku,
              marketplaceId: mkt.mp,
              format: 'FIXED_PRICE',
              listingDescription: part.notes || part.title,
              pricingSummary: { price: { value: String(part.list_price), currency: mkt.currency } },
              categoryId,
              merchantLocationKey,
              listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
              quantityLimitPerBuyer: 1,
            }),
          })
          const offerData = await offerRes.json()
          if (!offerRes.ok) throw new Error(offerData.errors?.[0]?.message || `Offer error ${offerRes.status}`)

          const offerId = offerData.offerId

          // 3. Update part + create listing record
          await sb.from('parts').update({ status: 'listed' }).eq('id', part.id)
          const { error: listingErr } = await sb.from('listings').insert({
            store_id:            storeId,
            part_id:             part.id,
            platform:            'ebay',
            platform_listing_id: offerId,
            platform_sku:        sku,
            status:              'draft',
            list_price:          part.list_price,
            platform_data:       { offerId, sku },
            photos:              part.photos || [],
            photos_archived:     false,
          })
          if (listingErr) throw new Error(`DB insert failed: ${listingErr.message}`)

          drafted++
        } catch (e: any) {
          failed++
          errors.push({ partId: part.id, sku: part.sku, error: e.message })
          console.error(`Draft failed for ${part.sku}:`, e.message)
        }
      }

      return json({ drafted, failed, errors })
    }

    if (action === 'market_lookup') {
      // Real eBay market data for a part: Browse (active comps + price range) and
      // Catalog (product/ePID match). App token — no user consent needed.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      let part = body.part
      if (!part && body.partId) {
        const { data } = await sb.from('parts').select('title, make, model, year, part_number, list_price, category').eq('id', body.partId).eq('store_id', storeId).single()
        part = data
      }
      if (!part) throw new Error('part or partId required')

      const pn = String(part.part_number || '').trim()
      const usePn = pn.length >= 4 && !/does not apply|n\/a|unknown|unbranded/i.test(pn)
      const q = (usePn ? pn : [part.make, part.model, part.year, part.title].filter(Boolean).join(' ')).slice(0, 100)
      const token = await getAppToken()
      // Price research must be LOCAL to the store's marketplace — AU comparables
      // are meaningless for a US/UK store (different market, different currency).
      const mktLookup = await storeMarketplace(sb, storeId)
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': mktLookup.mp, 'Content-Type': 'application/json' }

      let browse: any = null
      try {
        const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50&filter=${encodeURIComponent('conditions:{USED}')}`, { headers })
        if (r.ok) {
          const d = await r.json()
          const items = d.itemSummaries || []
          const prices = items.map((i: any) => +i.price?.value || 0).filter((p: number) => p > 0).sort((a: number, b: number) => a - b)
          const myPrice = +part.list_price || 0
          browse = {
            total: d.total ?? items.length,
            sampled: prices.length,
            min: prices[0] || 0,
            median: prices.length ? prices[Math.floor(prices.length / 2)] : 0,
            max: prices[prices.length - 1] || 0,
            myPrice,
            cheaperThanPct: (myPrice > 0 && prices.length) ? Math.round(prices.filter((p: number) => p > myPrice).length / prices.length * 100) : null,
            samples: items.slice(0, 5).map((i: any) => ({ title: i.title, price: +i.price?.value || 0, url: i.itemWebUrl })),
          }
        } else { browse = { error: `Browse ${r.status}` } }
      } catch (e) { browse = { error: (e as Error).message } }

      let catalog: any = null
      try {
        const r = await fetch(`https://api.ebay.com/commerce/catalog/v1_beta/product_summary/search?q=${encodeURIComponent(q)}&limit=3`, { headers })
        if (r.ok) {
          const d = await r.json()
          const p0 = (d.productSummaries || [])[0]
          if (p0) catalog = { epid: p0.epid, title: p0.title, image: p0.image?.imageUrl || null, brand: (p0.brands || [])[0] || null }
        }
      } catch (_) { /* best effort */ }

      // Cache the market median on the part so Insights can compute over/under
      // pricing without calling Browse for every row.
      if (body.partId && browse && !browse.error && browse.median > 0) {
        try { await sb.from('parts').update({ market_price: browse.median, market_count: browse.total, market_checked_at: new Date().toISOString() }).eq('id', body.partId).eq('store_id', storeId) } catch (_) { /* ignore */ }
      }
      return json({ ok: true, query: q, matchedBy: usePn ? 'part number' : 'make/model/title', browse, catalog })
    }

    if (action === 'refresh_market') {
      // Bulk-refresh cached market prices for in-stock parts (throttled, capped).
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      // Prefer never-checked / stalest first; cap so we stay within limits.
      const { data: parts } = await sb.from('parts')
        .select('id, title, make, model, year, part_number, list_price')
        .eq('store_id', storeId).eq('status', 'in_stock').is('deleted_at', null)
        .order('market_checked_at', { ascending: true, nullsFirst: true })
        .limit(Math.min(+body.limit || 60, 80))
      if (!parts?.length) return json({ ok: true, updated: 0, message: 'No in-stock parts to check' })

      const token = await getAppToken()
      // Market pricing must be local to the store's marketplace.
      const headers = { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': (await storeMarketplace(sb, storeId)).mp, 'Content-Type': 'application/json' }
      let updated = 0
      for (const p of parts) {
        const pn = String(p.part_number || '').trim()
        const usePn = pn.length >= 4 && !/does not apply|n\/a|unknown|unbranded/i.test(pn)
        const q = (usePn ? pn : [p.make, p.model, p.year, p.title].filter(Boolean).join(' ')).slice(0, 100)
        try {
          const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=50&filter=${encodeURIComponent('conditions:{USED}')}`, { headers })
          if (r.ok) {
            const d = await r.json()
            const prices = (d.itemSummaries || []).map((i: any) => +i.price?.value || 0).filter((x: number) => x > 0).sort((a: number, b: number) => a - b)
            const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0
            await sb.from('parts').update({ market_price: median || null, market_count: d.total ?? prices.length, market_checked_at: new Date().toISOString() }).eq('id', p.id)
            if (median > 0) updated++
          }
        } catch (_) { /* skip this one */ }
        await new Promise((res) => setTimeout(res, 150))
      }
      return json({ ok: true, updated, checked: parts.length })
    }

    if (action === 'category_aspects') {
      // Return the full item-aspect (item specifics) definition for a friendly
      // category — used by the bulk Specifics editor to render its fields.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      const category = body.category || ''
      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
        'Content-Language': mkt.lang, 'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      const map = await categoryMapFor(sb, mkt.mp)
      const categoryId = map[category] || '9886'
      const categoryTreeId = mkt.treeId
      let specs: any[] = []
      try {
        const aRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`, { headers: ebayHeaders })
        if (aRes.ok) {
          const aData = await aRes.json()
          specs = (aData.aspects || []).map((a: any) => ({
            name: a.localizedAspectName,
            required: !!a.aspectConstraint?.aspectRequired,
            mode: a.aspectConstraint?.aspectMode || 'FREE_TEXT',            // FREE_TEXT | SELECTION_ONLY
            multi: a.aspectConstraint?.itemToAspectCardinality === 'MULTI',
            allowed: (a.aspectValues || []).map((v: any) => v.localizedValue).filter(Boolean).slice(0, 200),
          })).filter((s: any) => s.name)
        }
      } catch (_) { /* return empty on taxonomy hiccup */ }
      return json({ ok: true, version: EDGE_FN_VERSION, categoryId, specs })
    }

    if (action === 'apply_specifics') {
      // Bulk-set item specifics across selected parts. Always writes the value as
      // a manual override (parts.ebay_overrides.specifics) so it's authoritative
      // on the next publish/preview. Optionally pushes to CURRENTLY LIVE listings
      // via Trading ReviseItem (best-effort, per-item errors collected).
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const partIds: string[] = Array.isArray(body.partIds) ? body.partIds : []
      const setVals: Record<string, string> = body.set || {}   // { aspectName: value }  ('' = clear)
      // HARD BLOCK: never push to live listings, whatever the caller asks for.
      // Local overrides still save and apply on the NEXT publish.
      const pushLive = ALLOW_LIVE_EBAY_EDITS && !!body.pushLive
      if (!partIds.length) return json({ error: 'No parts selected' }, 400)
      if (!Object.keys(setVals).length) return json({ error: 'No specifics to set' }, 400)

      const { data: canEdit } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'add_edit' })
      if (!canEdit) return json({ error: 'Not authorised' }, 403)
      if (pushLive) {
        const { data: canPub } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
        if (!canPub) return json({ error: 'Updating live eBay listings needs the publish permission' }, 403)
      }

      const { data: parts } = await sb.from('parts').select('id, ebay_overrides').eq('store_id', storeId).in('id', partIds)
      let updated = 0
      for (const p of (parts || [])) {
        const ov = p.ebay_overrides || {}
        const spec: Record<string, string> = { ...(ov.specifics || {}) }
        for (const [k, v] of Object.entries(setVals)) spec[k] = v as string
        const { error: uErr } = await sb.from('parts').update({ ebay_overrides: { ...ov, specifics: spec } }).eq('id', p.id)
        if (!uErr) updated++
      }

      let pushed = 0
      const failed: any[] = []
      if (pushLive) {
        const xesc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const { token, certId } = await getToken()
        const { data: live } = await sb.from('listings')
          .select('part_id, platform_listing_id').eq('store_id', storeId)
          .in('part_id', partIds).in('status', ['active', 'live']).is('deleted_at', null)
        for (const l of (live || [])) {
          const itemId = l.platform_listing_id
          if (!itemId) continue
          try {
            // Merge onto the listing's CURRENT specifics (ReviseItem replaces the
            // whole ItemSpecifics container, so we must send the full set).
            const gx = await trading(token, certId, 'GetItem',
              `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`)
            const merged: Record<string, string> = extractItemSpecifics(gx)
            for (const [k, v] of Object.entries(setVals)) { if (v === '' || v == null) delete merged[k]; else merged[k] = v as string }
            const nvl = Object.entries(merged).filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => `<NameValueList><Name>${xesc(k)}</Name><Value>${xesc(String(v))}</Value></NameValueList>`).join('')
            const rx = await trading(token, certId, 'ReviseItem',
              `<?xml version="1.0" encoding="utf-8"?><ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${itemId}</ItemID><ItemSpecifics>${nvl}</ItemSpecifics></Item></ReviseItemRequest>`)
            if (getTag(rx, 'Ack') === 'Failure') { failed.push({ item: itemId, error: getTag(rx, 'LongMessage') || 'ReviseItem failed' }); continue }
            pushed++
          } catch (e) { failed.push({ item: itemId, error: (e as Error).message }) }
        }
      }
      return json({ ok: true, version: EDGE_FN_VERSION, updated, pushed, failed })
    }

    if (action === 'preview_listing') {
      // Read-only preview of the eBay category + item specifics + fitment that a
      // publish would send for one part. Lets the user see everything we fill in.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: member } = await userClient.rpc('is_store_member', { p_store_id: storeId })
      if (!member) return json({ error: 'Not authorised' }, 403)

      const partId = body.partId
      if (!partId) throw new Error('partId required')
      const { data: part, error: pErr } = await sb.from('parts').select('*').eq('id', partId).eq('store_id', storeId).single()
      if (pErr || !part) throw new Error('Part not found')
      // Fill blank make/model/year from the donor car so fitment/compatibility
      // work for imported parts (matches publish).
      await hydrateVehicleFromCar(sb, part)
      // Reflect the editor's current (possibly unsaved) values so the preview
      // matches what's on screen — no need to save first.
      if (typeof body.title === 'string' && body.title) part.title = body.title
      if (body.price != null && body.price !== '') part.list_price = +body.price || 0
      if (typeof body.condition === 'string' && body.condition) part.condition = body.condition
      if (typeof body.description === 'string') part.description = body.description

      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mkt.lang,
        'Content-Language': mkt.lang,
        'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      const PREVIEW_CATEGORY_ID = await categoryMapFor(sb, mkt.mp)
      // Tree id per marketplace (US = eBay Motors tree 100 — its default tree has no vehicle parts).
      const categoryTreeId = mkt.treeId
      // Store config (same as publish): footer, shipping, best offer, image mix,
      // category learning. Loaded up front so category resolution can use it.
      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const settings = storeRow?.settings || {}

      // Category resolution priority: per-part override → learned (Part-type smart)
      // → live eBay Taxonomy suggestion → internal-category map → hard fallback.
      const catQuery = [part.make, part.model, part.year, part.category, part.title].filter(Boolean).join(' ')
      const ovCat = part.ebay_overrides || {}
      let categoryId = ''
      let categoryName = ''
      let categorySource = 'ai' // override | learned | ai | fallback
      if (ovCat.categoryId) {
        categoryId = String(ovCat.categoryId); categoryName = String(ovCat.categoryName || ''); categorySource = 'override'
      }
      if (!categoryId) {
        const L = learnedCategoryFor(settings, part)
        if (L) { categoryId = L.id; categoryName = L.name; categorySource = 'learned' }
      }
      if (!categoryId) {
        categoryId = PREVIEW_CATEGORY_ID[part.category] || '9886'; categorySource = 'fallback'
        try {
          const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(catQuery || 'car part')}`, { headers: ebayHeaders })
          if (r.ok) {
            const d = await r.json()
            const sug = d.categorySuggestions?.[0]
            if (sug?.category?.categoryId) {
              categoryId = sug.category.categoryId
              const anc = (sug.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse()
              categoryName = [...anc, sug.category.categoryName].filter(Boolean).join(' › ')
              categorySource = 'ai'
            }
          }
        } catch (_) { /* fallback id */ }
      }

      const { data: phRows } = await sb.from('photos').select('url, ebay_url, is_primary, display_order').eq('parent_type', 'part').eq('parent_id', partId).order('is_primary', { ascending: false }).order('display_order', { ascending: true })
      let partUrls = (phRows || []).map((r: any) => r.url || r.ebay_url).filter(Boolean)
      if (!partUrls.length) partUrls = (part.photos || []).map((p: any) => { if (p && typeof p === 'object') return p.url || p.ebay_url; try { const o = JSON.parse(p); return o.url || o.ebay_url || p } catch { return p } }).filter(Boolean)
      const comp = settings.imageComposition || {}
      const carMax = comp.carMax ?? 5
      const marketingMax = comp.marketingMax ?? 5
      const marketingImages: string[] = settings.marketingImages || []
      let carUrls: string[] = []
      if (part.car_id) {
        const { data: cph } = await sb.from('photos').select('url, ebay_url, is_primary, display_order').eq('parent_type', 'car').eq('parent_id', part.car_id).order('is_primary', { ascending: false }).order('display_order', { ascending: true })
        carUrls = (cph || []).map((r: any) => r.url || r.ebay_url).filter(Boolean).slice(0, carMax)
      }
      const photos = [...new Set([...partUrls, ...carUrls, ...marketingImages.slice(0, marketingMax)])].slice(0, 24)

      const { aspects, fitmentList, specs } = await fillAspects(part, categoryId, categoryTreeId, ebayHeaders, partUrls.slice(0, 4), settings.listingDefaults || {})
      // Show EVERY aspect eBay offers for this category, with our filled value
      // (or empty), so the user sees the full set and what's still blank.
      const ovSpec = (part.ebay_overrides && part.ebay_overrides.specifics) || {}
      const seen = new Set<string>()
      const specifics = (specs || []).map((s: any) => {
        seen.add(s.name)
        return { name: s.name, value: (aspects[s.name] || []).join(', '), required: !!s.required, options: (s.allowed || []).slice(0, 60), overridden: Object.prototype.hasOwnProperty.call(ovSpec, s.name) }
      })
      // Any filled aspect not in the spec list (shouldn't happen, but be safe).
      for (const [name, values] of Object.entries(aspects)) {
        if (!seen.has(name)) specifics.push({ name, value: (values as string[]).join(', '), required: false, options: [], overridden: Object.prototype.hasOwnProperty.call(ovSpec, name) })
      }

      // The exact description (body + compatible-with block + footer) and shipping
      // eBay will receive — so the preview has no surprises.
      const description = buildDescription(part, fitmentList, settings.footer || '')
      const shipping = settings.shipping || {}
      const shipCats = shipping.categories || {}
      const shipDefW = +shipping.defaultWeightG > 0 ? +shipping.defaultWeightG : 1000
      const shipDefDims = shipping.defaultDimsCm || {}
      const { weightG, dimL, dimW, dimH } = resolveShipping(part, shipCats, shipDefW, shipDefDims)

      const conditionDescription = String(part.condition_description || settings.listingDefaults?.conditionDescription || '').trim().slice(0, 1000)

      return json({
        ok: true, categoryId, categoryName, categorySource, specifics, fitment: fitmentList,
        title: part.title, description, photos,
        price: +part.list_price || 0, condition: part.condition || 'Used – Good',
        conditionDescription,
        hasFooter: !!(settings.footer && settings.footer.trim()),
        allowOffers: !!settings.allowOffers,
        weightG, dims: { l: dimL, w: dimW, h: dimH },
      })
    }

    // Search eBay's live category tree so the user can correct a wrong category.
    if (action === 'category_suggestions') {
      const q = String(body.query || '').trim()
      if (!q) return json({ suggestions: [] })
      const { token } = await getToken()
      const mkt = await storeMarketplace(sb, storeId)
      const headers = {
        'Authorization': `Bearer ${token}`, 'Accept': 'application/json',
        'Accept-Language': mkt.lang, 'Content-Language': mkt.lang, 'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }
      try {
        const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${mkt.treeId}/get_category_suggestions?q=${encodeURIComponent(q)}`, { headers })
        if (!r.ok) return json({ suggestions: [], error: `eBay ${r.status}` })
        const d = await r.json()
        const suggestions = (d.categorySuggestions || []).slice(0, 12).map((s: any) => {
          const anc = (s.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse()
          return { id: s.category?.categoryId, name: [...anc, s.category?.categoryName].filter(Boolean).join(' › ') }
        }).filter((s: any) => s.id)
        return json({ suggestions })
      } catch (e: any) { return json({ suggestions: [], error: String(e?.message || e) }) }
    }

    // Set (or clear) a part's eBay-category override and, when set, LEARN it for
    // future parts of the same type ("Part type (smart)").
    if (action === 'set_category') {
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: allowedCat } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (!allowedCat) return json({ error: 'You do not have permission to change listing categories for this store' }, 403)

      const partId = String(body.partId || '')
      if (!partId) throw new Error('partId required')
      const catId = String(body.categoryId || '').trim()
      const catName = String(body.categoryName || '').trim()
      const learn = body.learn !== false

      const { data: part, error: pErr } = await sb.from('parts').select('id, category, subcategory, make, model, title, part_number, ebay_overrides').eq('id', partId).eq('store_id', storeId).single()
      if (pErr || !part) throw new Error('Part not found')

      // Per-part override: set, or clear (reset to AI) when no categoryId given.
      const ov: any = { ...(part.ebay_overrides || {}) }
      if (catId) { ov.categoryId = catId; ov.categoryName = catName } else { delete ov.categoryId; delete ov.categoryName }
      await sb.from('parts').update({ ebay_overrides: ov }).eq('id', partId)

      // Learn for future parts with the same category key (read-merge-write settings).
      let learnedKey = ''
      if (catId && learn) {
        learnedKey = categoryKeyFor(part)
        const { data: sRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
        const settings = sRow?.settings || {}
        const map = { ...(settings.categoryLearning || {}) }
        map[learnedKey] = { id: catId, name: catName, at: new Date().toISOString() }
        await sb.from('stores').update({ settings: { ...settings, categoryLearning: map } }).eq('id', storeId)
      }
      return json({ ok: true, categoryId: catId, categoryName: catName, ebay_overrides: ov, learnedKey })
    }

    // ── SKU RECONCILE (eBay = source of truth) ─────────────────────────────
    // Austin lists a batch with ONE placeholder custom label, then fixes each
    // label on eBay when he shelves the item. Our sync SKIPS listings it already
    // knows, so those corrections never landed — hence the drift + EB-<itemId>
    // fallbacks. This re-reads the CURRENT label from eBay per live listing.
    // READ-ONLY: fetches from eBay, writes NOTHING (here or on eBay). Paged, so
    // the caller loops with nextOffset until hasMore is false, then classifies.
    if (action === 'sku_reconcile_report') {
      const { token, certId } = await getToken()
      const offset = +body.offset || 0
      const LIMIT = 30
      // The caller passes ONLY the parts whose SKU looks auto-generated — one
      // eBay GetItem per listing burns the Trading API daily quota, so we never
      // re-check the thousands of listings that are already correct.
      const only: string[] = Array.isArray(body.partIds) ? body.partIds : []
      if (!only.length) return json({ error: 'partIds required — refusing to scan every listing (eBay API quota)' }, 400)
      let lq = sb.from('listings')
        .select('platform_listing_id, platform_sku, part_id')
        .eq('store_id', storeId).eq('platform', 'ebay').in('status', ['live', 'active'])
        .is('deleted_at', null)
        .in('part_id', only)
        .order('platform_listing_id', { ascending: true })
        .range(offset, offset + LIMIT - 1)
      const { data: ls, error: lErr } = await lq
      if (lErr) throw lErr
      const partIds = [...new Set((ls || []).map((l: any) => l.part_id).filter(Boolean))]
      const { data: ps } = partIds.length
        ? await sb.from('parts').select('id, sku, title, status').in('id', partIds)
        : { data: [] as any[] }
      const partById = new Map((ps || []).map((p: any) => [p.id, p]))

      const rows: any[] = []
      for (const l of (ls || [])) {
        const part = partById.get(l.part_id)
        if (!part) continue
        let ebaySku = ''
        let err = ''
        try {
          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${l.platform_listing_id}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`)
          if (getTag(xml, 'Ack') === 'Failure') err = getTag(xml, 'LongMessage') || 'GetItem failed'
          else ebaySku = (getTag(xml, 'SKU') || '').trim()
        } catch (e: any) { err = String(e?.message || e).slice(0, 120) }
        rows.push({
          partId: part.id, itemId: l.platform_listing_id, title: part.title,
          currentSku: part.sku || '', ebaySku, storedPlatformSku: l.platform_sku || '', error: err,
        })
      }
      const { count } = await sb.from('listings').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId).eq('platform', 'ebay').in('status', ['live', 'active']).is('deleted_at', null)
        .in('part_id', only)
      const nextOffset = offset + LIMIT
      return json({ ok: true, version: EDGE_FN_VERSION, rows, total: count || 0, hasMore: nextOffset < (count || 0), nextOffset })
    }

    // Apply ONLY the rows the user reviewed. Local write to parts.sku (+ the
    // listing's platform_sku mirror). NEVER touches eBay. Two-phase rename so a
    // swap can't transiently violate parts_sku_store_unique; full rollback on
    // failure. Every change is captured by the parts audit trigger (old→new).
    if (action === 'sku_reconcile_apply') {
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: mayEdit } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (!mayEdit) return json({ error: 'You do not have permission to reconcile SKUs for this store' }, 403)

      const updates: { partId: string; newSku: string }[] = Array.isArray(body.updates) ? body.updates : []
      if (!updates.length) return json({ error: 'No updates supplied' }, 400)

      // Guard: no blank targets, no duplicate targets within the batch.
      const seen = new Set<string>()
      for (const u of updates) {
        const s = String(u.newSku || '').trim()
        if (!s) return json({ error: `Blank target SKU for part ${u.partId} — refused` }, 400)
        if (seen.has(s)) return json({ error: `Duplicate target SKU "${s}" in this batch — refused (Austin has not shelved these yet)` }, 400)
        seen.add(s)
      }
      // Guard: a target already held by a part that is NOT being renamed here.
      const ids = updates.map(u => u.partId)
      const { data: holders } = await sb.from('parts').select('id, sku').eq('store_id', storeId).in('sku', [...seen])
      const blocked = (holders || []).filter((h: any) => !ids.includes(h.id))
      if (blocked.length) return json({ error: `Target SKU(s) already used by other parts: ${blocked.map((b: any) => b.sku).join(', ')}` }, 409)

      const { data: before } = await sb.from('parts').select('id, sku').eq('store_id', storeId).in('id', ids)
      const original = new Map((before || []).map((p: any) => [p.id, p.sku]))
      const rollback = async () => {
        for (const [id, sku] of original) await sb.from('parts').update({ sku }).eq('id', id).eq('store_id', storeId)
      }
      try {
        // Phase 1 — park every row on a temp value so swaps can't collide.
        for (const u of updates) {
          const { error } = await sb.from('parts').update({ sku: `__pvtmp_${u.partId}` }).eq('id', u.partId).eq('store_id', storeId)
          if (error) throw new Error(`temp rename failed for ${u.partId}: ${error.message}`)
        }
        // Phase 2 — set the real eBay label.
        for (const u of updates) {
          const { error } = await sb.from('parts').update({ sku: String(u.newSku).trim() }).eq('id', u.partId).eq('store_id', storeId)
          if (error) throw new Error(`rename failed for ${u.partId}: ${error.message}`)
        }
      } catch (e: any) {
        await rollback()
        return json({ error: `Reconcile aborted and rolled back — nothing changed. ${String(e?.message || e)}` }, 500)
      }
      // Mirror onto the listing so the stored platform_sku stops being stale.
      for (const u of updates) {
        await sb.from('listings').update({ platform_sku: String(u.newSku).trim() })
          .eq('store_id', storeId).eq('platform', 'ebay').eq('part_id', u.partId).in('status', ['live', 'active'])
      }
      return json({ ok: true, version: EDGE_FN_VERSION, updated: updates.length })
    }

    if (action === 'publish_listings') {
      // ── Authorize: caller must hold the 'publish' capability for this store ──
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } }
      )
      const { data: allowed, error: permErr } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (permErr) throw permErr
      if (!allowed) return json({ error: 'You do not have permission to publish listings for this store' }, 403)

      const { token } = await getToken()
      const partIds: string[] = body.partIds ?? []
      if (!partIds.length) throw new Error('No part IDs provided')

      const { data: parts, error: partsErr } = await sb
        .from('parts').select('*').in('id', partIds).eq('store_id', storeId)
      if (partsErr) throw partsErr
      if (!parts?.length) throw new Error('No parts found')

      const mkt = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mkt.lang,
        'Content-Language': mkt.lang,
        'X-EBAY-C-MARKETPLACE-ID': mkt.mp,
      }

      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${mkt.mp}`, { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])
      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      const merchantLocationKey = await ensureMerchantLocation(ebayHeaders, locData.locations?.[0]?.merchantLocationKey)
      if (!merchantLocationKey) throw new Error('No ship-from address saved — add it in Settings → eBay Inventory Location, then list again (it is created on eBay automatically).')

      // Auto-parts categories only accept "Used" (id 3000 = USED_EXCELLENT enum),
      // "For parts" (7000), "New" (1000), or Refurbished — NOT the graded
      // USED_GOOD/USED_ACCEPTABLE conditions (those are media-only).
      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT', 'Used – Good': 'USED_EXCELLENT', 'Used – Fair': 'USED_EXCELLENT',
        'For Parts Only': 'FOR_PARTS_OR_NOT_WORKING', 'Refurbished': 'SELLER_REFURBISHED',
      }
      // Resolved per the store's marketplace (category_maps; AU fallback).
      const CATEGORY_ID = await categoryMapFor(sb, mkt.mp)

      // Store-wide image composition config: shared car/marketing images added
      // to every listing, with per-source budgets (eBay allows up to 24 images).
      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const comp = storeRow?.settings?.imageComposition || {}
      const carMax = comp.carMax ?? 5
      const marketingMax = comp.marketingMax ?? 5
      const marketingImages: string[] = storeRow?.settings?.marketingImages || []
      const EBAY_MAX_IMAGES = 24

      // Shipping: per-category preset > store default > hardcoded. Weight in grams,
      // dims in cm. Per-part weight (part.weight) overrides everything.
      const shipping = storeRow?.settings?.shipping || {}
      const shipCats = shipping.categories || {}
      const shipDefW = +shipping.defaultWeightG > 0 ? +shipping.defaultWeightG : 1000
      const shipDefDims = shipping.defaultDimsCm || {}

      const photoUrls = async (parentType: string, parentId: string) => {
        const { data } = await sb.from('photos')
          .select('url, ebay_url, is_primary, display_order')
          .eq('parent_type', parentType).eq('parent_id', parentId)
          .order('is_primary', { ascending: false }).order('display_order', { ascending: true })
        return (data || []).map((r: any) => r.url || r.ebay_url).filter(Boolean)
      }

      // eBay requires a LEAF category. Ask the Taxonomy API for the best leaf from
      // the part's title; the per-marketplace map is the fallback. Tree id comes
      // from the store's marketplace (US = eBay Motors tree 100).
      const categoryTreeId = mkt.treeId
      const leafCategoryFor = async (query: string): Promise<string | null> => {
        try {
          const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodeURIComponent(query || 'car part')}`, { headers: ebayHeaders })
          if (!r.ok) return null
          const d = await r.json()
          return d.categorySuggestions?.[0]?.category?.categoryId || null
        } catch (_) { return null }
      }

      let published = 0
      let failed = 0
      const errors: any[] = []
      const results: any[] = []

      for (const part of parts) {
        try {
          // ══ HARD BLOCK ══ Never touch a listing that is already live on eBay.
          // Checked BEFORE any eBay write (inventory replace / compatibility /
          // offer update), so a re-publish can never alter a live listing.
          //
          // ⚠ FAIL-CLOSED. The import writes status 'live'; publish writes
          // 'active'. v3.36.11-12 only checked 'active', so the block silently
          // never fired for imported listings. Anything that is NOT a known
          // dead state therefore counts as live — a new/unknown status must
          // block, never wave a write through.
          if (!ALLOW_LIVE_EBAY_EDITS) {
            const DEAD = ['ended', 'sold', 'cancelled', 'canceled', 'deleted', 'draft', 'unsold']
            const { data: anyL } = await sb.from('listings')
              .select('platform_listing_id, status').eq('part_id', part.id)
              .eq('platform', 'ebay').is('deleted_at', null)
            const stillLive = (anyL || []).filter((l: any) => !DEAD.includes(String(l.status || '').toLowerCase()))
            if (stillLive.length) {
              throw new Error(`BLOCKED — already on eBay (item ${stillLive[0].platform_listing_id}, status "${stillLive[0].status}"). Editing live listings is disabled in this build; nothing was sent to eBay.`)
            }
          }
          // Fill blank make/model/year from the donor car BEFORE building fitment,
          // so imported parts still get eBay Parts Compatibility.
          await hydrateVehicleFromCar(sb, part)
          // Blocking SKU gate
          let sku = part.sku
          if (!sku || !String(sku).trim()) {
            const { data: gen, error: genErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: part.make || null })
            if (genErr || !gen) throw new Error(`Cannot list without a SKU (auto-generation failed: ${genErr?.message || 'no SKU'})`)
            sku = gen as string
            await sb.from('parts').update({ sku }).eq('id', part.id)
          }

          const condition  = CONDITION_MAP[part.condition] || 'USED_GOOD'
          // Bias the category lookup toward auto parts (make/model/category, not
          // just the title) so a vague title doesn't match a media category.
          const catQuery = [part.make, part.model, part.year, part.category, part.title].filter(Boolean).join(' ')
          // Same priority as the preview: per-part override → learned (Part-type
          // smart) → live Taxonomy suggestion → internal-category map → fallback.
          const categoryId = String(part.ebay_overrides?.categoryId || '')
            || learnedCategoryFor(storeRow?.settings, part)?.id
            || (await leafCategoryFor(catQuery)) || CATEGORY_ID[part.category] || '9886'
          // Compose images: the part's own photos first (eBay's gallery image),
          // then up to carMax donor-car photos, then up to marketingMax store
          // marketing images. Deduped and capped at eBay's 24.
          let partUrls = await photoUrls('part', part.id)
          if (!partUrls.length) {
            // Legacy parts.photos: text[] of plain URLs or stringified {"url":...}
            partUrls = (part.photos || []).map((p: any) => {
              if (p && typeof p === 'object') return p.url || p.ebay_url
              try { const o = JSON.parse(p); return o.url || o.ebay_url || p } catch { return p }
            }).filter(Boolean)
          }
          const carUrls = part.car_id ? (await photoUrls('car', part.car_id)).slice(0, carMax) : []
          const marketingUrls = marketingImages.slice(0, marketingMax)
          let imageUrls = [...new Set([...partUrls, ...carUrls, ...marketingUrls])].slice(0, EBAY_MAX_IMAGES)
          // Item specifics + confident fitment (shared with the preview action).
          // Cap at 4 images — each costs ~1.5k Anthropic input tokens and the org
          // rate limit is 10k/min; 4 keeps identification quality with headroom.
          const aiPhotos = (partUrls.length ? partUrls : imageUrls).slice(0, 4)
          const { aspects, fitmentList } = await fillAspects(part, categoryId, categoryTreeId, ebayHeaders, aiPhotos, storeRow?.settings?.listingDefaults || {})

          // Full listing description: the part's description (or notes) + the
          // store's standard footer from settings.
          const footer = storeRow?.settings?.footer || ''
          const fullDescription = buildDescription(part, fitmentList, footer)
          const allowOffers = !!storeRow?.settings?.allowOffers
          // Condition description: per-part override, else the store's default
          // blurb (Settings → Listing defaults). eBay accepts it for used /
          // refurbished / for-parts items (max 1000 chars), not for NEW.
          const condDesc = String(part.condition_description || storeRow?.settings?.listingDefaults?.conditionDescription || '').trim().slice(0, 1000)
          // Package weight (grams) + dimensions (cm) — shared with the preview.
          const { weightG, dimL, dimW, dimH } = resolveShipping(part, shipCats, shipDefW, shipDefDims)

          // 1. Create/replace the inventory item (PUT is idempotent)
          const invRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
            method: 'PUT', headers: ebayHeaders,
            body: JSON.stringify({
              product: { title: part.title, description: fullDescription, aspects, ...(imageUrls.length ? { imageUrls } : {}) },
              condition,
              ...(condDesc && condition !== 'NEW' ? { conditionDescription: condDesc } : {}),
              availability: { shipToLocationAvailability: { quantity: 1 } },
              packageWeightAndSize: {
                weight: { value: weightG, unit: 'GRAM' },
                dimensions: { length: dimL, width: dimW, height: dimH, unit: 'CENTIMETER' },
              },
            }),
          })
          if (!invRes.ok && invRes.status !== 204) {
            throw new Error(`Inventory item ${invRes.status}: ${(await invRes.text()).slice(0, 300)}`)
          }

          // 1b. eBay Parts Compatibility (the real "fits my vehicle" system).
          // Best-effort: many non-motors categories don't support it and invalid
          // catalogue entries are rejected — so we never let it block a publish.
          // The outcome is captured (never silently swallowed) and returned per
          // part, so an empty "fits my vehicle" list is diagnosable.
          const compat: { vehicles: number; added: number; status: number; reason: string } =
            { vehicles: fitmentList.length, added: 0, status: 0, reason: '' }
          if (!fitmentList.length) {
            compat.reason = (part.make && part.model)
              ? 'No fitment produced (AI returned none; donor should have been injected — check make/model)'
              : `Part has no make/model${part.car_id ? ' (and donor car had none)' : ''} — cannot build compatibility`
          }
          if (fitmentList.length) {
            try {
              const compatibleProducts: any[] = []
              for (const f of fitmentList) {
                if (!f.make || !f.model) continue
                const yf = +f.yearFrom, yt = +f.yearTo || yf
                const years: string[] = []
                if (yf) for (let y = yf; y <= yt && y - yf < 40; y++) years.push(String(y))
                else years.push('')
                for (const y of years) {
                  const props: any[] = [{ name: 'Make', value: String(f.make) }, { name: 'Model', value: String(f.model) }]
                  if (y) props.push({ name: 'Year', value: y })
                  if (f.trim) props.push({ name: 'Trim', value: String(f.trim) })
                  if (f.engine) props.push({ name: 'Engine', value: String(f.engine) })
                  compatibleProducts.push({ compatibilityProperties: props, ...(part.part_number ? { notes: `Part #: ${part.part_number}` } : {}) })
                  if (compatibleProducts.length >= 200) break
                }
                if (compatibleProducts.length >= 200) break
              }
              if (!compatibleProducts.length) {
                compat.reason = 'Fitment entries all missing make/model'
              } else {
                const compatRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}/product_compatibility`, {
                  method: 'PUT', headers: ebayHeaders, body: JSON.stringify({ compatibleProducts }),
                })
                compat.status = compatRes.status
                if (compatRes.ok || compatRes.status === 204) {
                  compat.added = compatibleProducts.length
                } else {
                  compat.reason = `eBay rejected compatibility (${compatRes.status}): ${(await compatRes.text()).slice(0, 240)}`
                  console.warn(`Parts compatibility rejected for ${sku}: ${compat.reason}`)
                }
              }
            } catch (e: any) {
              compat.reason = `Compatibility error: ${String(e?.message || e).slice(0, 200)}`
              console.warn('Parts compatibility error', e)
            }
          }

          // 2. Create the offer — or reuse an existing one for this SKU
          const offerBody = {
            sku, marketplaceId: mkt.mp, format: 'FIXED_PRICE',
            // Fixed-price Inventory API listings are always Good 'Til Cancelled;
            // set it explicitly so the listing duration is never left ambiguous.
            listingDuration: 'GTC',
            listingDescription: fullDescription,
            pricingSummary: { price: { value: String(part.list_price), currency: mkt.currency } },
            categoryId, merchantLocationKey,
            listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId, ...(allowOffers ? { bestOfferTerms: { bestOfferEnabled: true } } : {}) },
            quantityLimitPerBuyer: 1,
          }
          let offerId: string | undefined
          const offerRes = await fetch('https://api.ebay.com/sell/inventory/v1/offer', { method: 'POST', headers: ebayHeaders, body: JSON.stringify(offerBody) })
          if (offerRes.ok) {
            offerId = (await offerRes.json()).offerId
          } else {
            const offerData = await offerRes.json()
            const msg = offerData.errors?.[0]?.message || ''
            if (offerRes.status === 409 || /already exists/i.test(msg)) {
              const getRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${mkt.mp}`, { headers: ebayHeaders })
              offerId = (await getRes.json()).offers?.[0]?.offerId
              if (!offerId) throw new Error('Offer already exists but could not be retrieved')
              // HARD BLOCK: an existing offer may back a LIVE listing — updating it
              // would edit that listing. Disabled; reuse the offer as-is.
              if (ALLOW_LIVE_EBAY_EDITS) {
                await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}`, { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(offerBody) })
              }
            } else {
              throw new Error(msg || `Offer error ${offerRes.status}`)
            }
          }

          // 3. PUBLISH — this makes the listing LIVE on eBay
          const pubRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`, { method: 'POST', headers: ebayHeaders })
          const pubData = await pubRes.json()
          if (!pubRes.ok) throw new Error(pubData.errors?.[0]?.message || `Publish error ${pubRes.status}`)
          const listingId = pubData.listingId

          // 4. Record it — part now listed; listing status MUST be 'live': the
          // listings_status_check constraint rejects 'active' (see the import at
          // ~L837). This insert previously used 'active' AND ignored its error,
          // so every publish silently failed to record its listing row — which
          // also blinded the live-listing guard until the next sync. Error is
          // now surfaced rather than swallowed.
          await sb.from('parts').update({ status: 'listed' }).eq('id', part.id)
          await sb.from('listings').delete().eq('part_id', part.id).eq('platform', 'ebay').neq('status', 'sold')
          const { error: lIns } = await sb.from('listings').insert({
            store_id: storeId, part_id: part.id, platform: 'ebay',
            platform_listing_id: listingId, platform_sku: sku, status: 'live',
            list_price: part.list_price, listed_at: new Date().toISOString(),
            platform_data: { offerId, listingId, sku }, photos: part.photos || [], photos_archived: false,
          })
          if (lIns) throw new Error(`Listed on eBay (item ${listingId}) but recording it here failed: ${lIns.message}`)

          published++
          results.push({ partId: part.id, sku, listingId, compatibility: compat })
        } catch (e: any) {
          failed++
          errors.push({ partId: part.id, sku: part.sku, error: e.message })
          console.error(`Publish failed for ${part.sku}:`, e.message)
        }
      }

      return json({ published, failed, errors, results })
    }

    if (action === 'delist_listings') {
      // End live eBay listings for the selected parts, optionally binning the parts.
      const authHeader = req.headers.get('Authorization') || ''
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: canPub } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
      if (!canPub) return json({ error: 'You do not have permission to manage eBay listings for this store' }, 403)
      const bin = !!body.bin
      if (bin) {
        const { data: canDel } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'delete' })
        if (!canDel) return json({ error: 'You need Delete permission to bin parts' }, 403)
      }

      const { token, certId } = await getToken()
      const partIds: string[] = body.partIds ?? []
      if (!partIds.length) throw new Error('No part IDs provided')

      const mktDelist = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json',
        'Accept-Language': mktDelist.lang, 'Content-Language': mktDelist.lang, 'X-EBAY-C-MARKETPLACE-ID': mktDelist.mp,
      }
      const now = new Date().toISOString()
      let delisted = 0
      let failed = 0
      const errors: any[] = []

      for (const partId of partIds) {
        try {
          const { data: listings } = await sb.from('listings').select('*')
            .eq('part_id', partId).eq('platform', 'ebay').in('status', ['active', 'live']).is('deleted_at', null)
          for (const listing of (listings || [])) {
            const offerId = listing.platform_data?.offerId
            if (offerId) {
              // Listings we published — withdraw the offer
              const r = await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/withdraw`, { method: 'POST', headers: ebayHeaders })
              if (!r.ok && r.status !== 404) throw new Error(`Withdraw ${r.status}: ${(await r.text()).slice(0, 200)}`)
            } else if (listing.platform_listing_id) {
              // Imported listings — end via the Trading API
              const xml = await trading(token, certId, 'EndFixedPriceItem',
                `<?xml version="1.0" encoding="utf-8"?><EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${listing.platform_listing_id}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`)
              const ack = getTag(xml, 'Ack')
              if (ack && ack !== 'Success' && ack !== 'Warning') {
                const msg = getTag(xml, 'LongMessage') || getTag(xml, 'ShortMessage')
                // Treat "already ended/unavailable" as success
                if (!/ended|no longer|not available|auction.*closed/i.test(msg)) throw new Error(msg || 'End listing failed')
              }
            }
            await sb.from('listings').update({ status: 'ended', ended_at: now }).eq('id', listing.id)
          }
          if (bin) await sb.from('parts').update({ deleted_at: now }).eq('id', partId)
          else await sb.from('parts').update({ status: 'in_stock' }).eq('id', partId)
          delisted++
        } catch (e: any) {
          failed++
          errors.push({ partId, error: e.message })
        }
      }
      return json({ delisted, failed, errors })
    }

    if (action === 'get_ebay_username') {
      const { token, certId } = await getToken()
      const xml = await trading(token, certId, 'GetUser', `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetUserRequest>`)
      const username = getTag(xml, 'UserID')
      if (!username) throw new Error('Could not fetch eBay username')
      return json({ username })
    }

    if (action === 'setup_ebay_location') {
      const { token } = await getToken()
      const address = body.address
      if (!address?.addressLine1 || !address?.city || !address?.postalCode || !address?.country) {
        throw new Error('Address line, city, postcode, and country are required')
      }

      const mktLoc = await storeMarketplace(sb, storeId)
      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': mktLoc.lang,
        'Content-Language': mktLoc.lang,
        'X-EBAY-C-MARKETPLACE-ID': mktLoc.mp,
      }

      const merchantLocationKey = 'PARTVAULT_MAIN'

      // Check if it already exists
      const existingRes = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${merchantLocationKey}`, { headers: ebayHeaders })

      const payload = {
        location: {
          address: {
            addressLine1:    address.addressLine1,
            city:            address.city,
            stateOrProvince: address.stateOrProvince || '',
            postalCode:      address.postalCode,
            country:         address.country.toUpperCase(),
          },
        },
        name: 'PartVault Main',
        merchantLocationStatus: 'ENABLED',
        locationTypes: ['WAREHOUSE'],
      }

      if (existingRes.ok) {
        // Update existing
        const updateRes = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${merchantLocationKey}/update_location_details`, {
          method: 'POST',
          headers: ebayHeaders,
          body: JSON.stringify({ address: payload.location.address }),
        })
        if (!updateRes.ok && updateRes.status !== 204) {
          const e = await updateRes.json().catch(() => ({}))
          throw new Error(`Failed to update location: ${e.errors?.[0]?.message || updateRes.status}`)
        }
      } else {
        // Create new
        const createRes = await fetch(`https://api.ebay.com/sell/inventory/v1/location/${merchantLocationKey}`, {
          method: 'POST',
          headers: ebayHeaders,
          body: JSON.stringify(payload),
        })
        if (!createRes.ok && createRes.status !== 204) {
          const e = await createRes.json().catch(() => ({}))
          throw new Error(`Failed to create location: ${e.errors?.[0]?.message || createRes.status}`)
        }
      }

      return json({ merchantLocationKey })
    }

    throw new Error(`Unknown action: ${action}`)

  } catch (e: any) {
    console.error('Edge function error:', e.message)
    return json({ error: e.message }, 400)
  }
}
