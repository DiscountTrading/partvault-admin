// Australian make/model reference + a title parser used to recover the donor
// vehicle from an eBay-imported part's title (imports don't set make/model — the
// vehicle is only in the title). Shared by Inventory (dropdowns) and Vehicles
// (the "Parse from titles" backfill).

export const MAKES = [
  'Toyota','Ford','Holden','Mazda','Hyundai','Kia','Mitsubishi','Nissan','Subaru','Honda',
  'Volkswagen','BMW','Mercedes-Benz','Audi','Land Rover','Isuzu','Suzuki','Lexus','Jeep','Volvo',
  'Renault','Peugeot','Citroen','Skoda','Fiat','Alfa Romeo','MINI','Porsche','Jaguar','Chrysler',
  'Dodge','MG','LDV','GWM','Haval','Chery','SsangYong','Daihatsu','Proton','Tesla','Genesis','Saab',
  'Other',
]

export const MODEL_SUGS = {
  Toyota: ['Hilux','Camry','Corolla','RAV4','LandCruiser','LandCruiser 200','LandCruiser 79','Prado','HiAce','Kluger','Yaris','Aurion','C-HR','86','Fortuner','Tarago','Echo','Avensis','FJ Cruiser','Rukus','Supra','Granvia'],
  Ford: ['Ranger','Falcon','Territory','Focus','Fiesta','Escape','Explorer','Mustang','Transit','Mondeo','Kuga','Everest','Endura','Puma','Ecosport','Courier','Laser','Fairmont','Fairlane','Festiva'],
  Holden: ['Commodore','Colorado','Trax','Captiva','Cruze','Astra','Barina','Trailblazer','Calais','Caprice','Statesman','Crewman','Rodeo','Epica','Viva','Spark','Acadia','Equinox','Malibu','Ute','Berlina','Monaro'],
  Mazda: ['CX-5','CX-3','CX-9','CX-7','CX-8','CX-30','Mazda2','Mazda3','Mazda6','BT-50','MX-5','RX-7','RX-8','121','323','626','Tribute','Premacy','Bravo'],
  Hyundai: ['i30','Tucson','Santa Fe','i20','i40','Accent','Elantra','Sonata','ix35','Kona','Getz','Veloster','iLoad','iMax','Palisade','Venue','Staria','Terracan','Excel','Iload'],
  Kia: ['Sportage','Cerato','Rio','Sorento','Carnival','Stinger','Seltos','Picanto','Soul','Spectra','Optima','Niro','EV6','Sportage','Grand Carnival','Pro_Cee\'d','Magentis'],
  Mitsubishi: ['Triton','ASX','Outlander','Eclipse Cross','Pajero','Pajero Sport','Lancer','Mirage','Magna','Express','380','Challenger','Colt','Grandis','Verada','Outlander PHEV'],
  Nissan: ['Navara','X-Trail','Patrol','Pathfinder','Qashqai','Pulsar','Skyline','Micra','Maxima','350Z','370Z','Murano','Juke','Dualis','Tiida','Almera','Cube','Leaf','Elgrand','Note','GT-R'],
  Subaru: ['Forester','Outback','Impreza','Liberty','WRX','BRZ','XV','Tribeca','Levorg','Crosstrek','Exiga'],
  Honda: ['CR-V','HR-V','Jazz','Civic','Accord','City','Odyssey','Legend','Integra','S2000','NSX','Insight','Accord Euro','CR-Z','MDX'],
  Volkswagen: ['Golf','Polo','Tiguan','Passat','Amarok','Caddy','Transporter','Touareg','Jetta','Beetle','Multivan','Crafter','T-Cross','T-Roc','Up','Eos','Scirocco','Bora'],
  BMW: ['1 Series','2 Series','3 Series','4 Series','5 Series','6 Series','7 Series','8 Series','X1','X2','X3','X4','X5','X6','X7','Z4','M3','M5','i3'],
  'Mercedes-Benz': ['A-Class','B-Class','C-Class','E-Class','S-Class','CLA','CLS','GLA','GLB','GLC','GLE','GLS','ML','GL','Vito','Sprinter','V-Class','Valente','SLK','Viano'],
  Audi: ['A1','A3','A4','A5','A6','A7','A8','Q2','Q3','Q5','Q7','Q8','TT','S3','RS3','S4','S5'],
  'Land Rover': ['Discovery','Discovery Sport','Range Rover','Range Rover Sport','Range Rover Evoque','Range Rover Velar','Defender','Freelander'],
  Isuzu: ['D-Max','MU-X','NPR','NLR','FRR'],
  Suzuki: ['Swift','Vitara','Grand Vitara','Jimny','Baleno','Ignis','S-Cross','Alto','SX4','Liana','APV','Kizashi'],
  Lexus: ['RX','NX','GX','IS','ES','LS','UX','LC','RC','CT','LX'],
  Jeep: ['Wrangler','Cherokee','Grand Cherokee','Compass','Renegade','Patriot'],
  Volvo: ['XC90','XC60','XC40','S60','S90','V40','V60','XC70','C30','S40','V50'],
  Renault: ['Megane','Clio','Koleos','Trafic','Master','Captur','Kangoo','Scenic','Latitude'],
  Peugeot: ['208','308','3008','2008','5008','partner','expert','boxer','207','206','307','4007','508'],
  Citroen: ['C3','C4','C5','Berlingo','Dispatch','Relay','C4 Aircross'],
  Skoda: ['Octavia','Fabia','Superb','Kodiaq','Karoq','Rapid','Yeti','Kamiq'],
  Fiat: ['500','Ducato','Punto','Doblo','Scudo','Freemont'],
  'Alfa Romeo': ['Giulietta','Giulia','Stelvio','159','Mito','147'],
  MINI: ['Cooper','Countryman','Clubman','Paceman'],
  Porsche: ['Cayenne','Macan','911','Panamera','Boxster','Cayman'],
  Jaguar: ['XF','XE','XJ','F-Pace','E-Pace','F-Type','S-Type','X-Type'],
  Chrysler: ['300C','300','Sebring','Grand Voyager','PT Cruiser'],
  Dodge: ['Journey','Caliber','Nitro','Ram'],
  MG: ['ZS','MG3','HS','MG6','GS','ZST','MG5'],
  LDV: ['G10','T60','V80','Deliver 9','D90','G10+'],
  GWM: ['Cannon','Ute','H6','Jolion','Steed','V200','X240'],
  Haval: ['H6','H2','H9','Jolion'],
  Chery: ['Tiggo','J11','J3','Omoda'],
  SsangYong: ['Musso','Rexton','Korando','Actyon','Stavic'],
  Daihatsu: ['Sirion','Terios','Charade','YRV','Cuore'],
  Proton: ['Gen-2','Persona','Jumbuck','Satria'],
  Tesla: ['Model 3','Model Y','Model S','Model X'],
  Genesis: ['G70','G80','GV70','GV80'],
  Saab: ['9-3','9-5'],
}

// Common spelling/abbreviation variants → canonical make.
const MAKE_ALIASES = {
  vw: 'Volkswagen', volkswagon: 'Volkswagen', 'volks wagen': 'Volkswagen',
  mercedes: 'Mercedes-Benz', merc: 'Mercedes-Benz', benz: 'Mercedes-Benz', 'mercedes benz': 'Mercedes-Benz', 'merc benz': 'Mercedes-Benz',
  landrover: 'Land Rover', 'range rover': 'Land Rover', rangerover: 'Land Rover',
  chevrolet: 'Holden', chev: 'Holden', chevy: 'Holden', vauxhall: 'Holden', hsv: 'Holden',
  'great wall': 'GWM', greatwall: 'GWM',
  'ssang yong': 'SsangYong',
  'alfa': 'Alfa Romeo', alfaromeo: 'Alfa Romeo',
  volvo: 'Volvo',
}

// Makes whose name is a common English word — don't token-match them directly
// (too many false positives); only reach them via a distinctive model.
const SKIP_DIRECT = new Set(['MINI'])

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A word-boundary regex that tolerates the token's own spaces/hyphens being
// written either way, AND an optional separator at any letter↔digit boundary —
// so "Mazda2" also matches "Mazda 2" / "Mazda-2", "CX5" matches "CX-5" / "CX 5",
// "i30" matches "i 30", etc.
const tokenRe = tok => new RegExp('\\b' + escapeRe(tok.toLowerCase())
  .replace(/[-\s]+/g, '[-\\s]?')
  .replace(/([a-z])(\d)/g, '$1[-\\s]?$2')
  .replace(/(\d)([a-z])/g, '$1[-\\s]?$2') + '\\b')

// Parse make / model / year out of a free-text part title. Best-effort: returns
// blanks for anything it can't confidently match.
export function parseVehicle(title = '') {
  const t = (title || '').toLowerCase()

  // ── make: earliest confident match wins (handles titles naming two vehicles) ──
  let make = '', makeIdx = Infinity
  for (const mk of MAKES) {
    if (mk === 'Other' || SKIP_DIRECT.has(mk)) continue
    const idx = t.search(tokenRe(mk))
    if (idx >= 0 && idx < makeIdx) { make = mk; makeIdx = idx }
  }
  for (const [alias, mk] of Object.entries(MAKE_ALIASES)) {
    const idx = t.search(tokenRe(alias))
    if (idx >= 0 && idx < makeIdx) { make = mk; makeIdx = idx }
  }

  // ── model: prefer models of the matched make (longest first); else infer the
  //    make from a distinctive model token (≥3 chars to avoid false positives) ──
  let model = ''
  const matchModel = (mk) => {
    const cands = (MODEL_SUGS[mk] || []).slice().sort((a, b) => b.length - a.length)
    for (const md of cands) if (tokenRe(md).test(t)) return md
    return ''
  }
  if (make) model = matchModel(make)
  if (!model) {
    const all = Object.entries(MODEL_SUGS)
      .flatMap(([mk, ms]) => ms.map(md => [mk, md]))
      .filter(([, md]) => md.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
    for (const [mk, md] of all) {
      if (tokenRe(md).test(t)) { model = md; if (!make) make = mk; break }
    }
  }

  return { make, model, year: parseYearRange(title) }
}

// Extract a model year OR a fitment year RANGE from a title. eBay titles usually
// give a range ("2002-2006", "08/2002-07/2006", "05/09-10/13") — we keep the
// range so it matches the listing instead of collapsing to the first year.
export function parseYearRange(title = '') {
  // Prefer 4-digit years; if none, fall back to MM/YY tokens (e.g. 05/09, 10/96).
  let years = [...title.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)].map(m => +m[1])
  if (!years.length) {
    years = [...title.matchAll(/\b\d{1,2}\/(\d{2})\b/g)].map(m => {
      const n = +m[1]; return n <= 49 ? 2000 + n : 1900 + n
    })
  }
  if (!years.length) return ''
  const lo = Math.min(...years), hi = Math.max(...years)
  return lo === hi ? String(lo) : `${lo}-${hi}`
}
