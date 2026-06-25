// Australian make/model reference + a title parser used to recover the donor
// vehicle from an eBay-imported part's title (imports don't set make/model — the
// vehicle is only in the title). Shared by Inventory (dropdowns) and Vehicles
// (the "Parse from titles" backfill).

export const MAKES = ['Toyota','Ford','Holden','Mazda','Hyundai','Kia','Mitsubishi','Nissan','Subaru','Honda','Volkswagen','BMW','Mercedes-Benz','Audi','Land Rover','Isuzu','Suzuki','Lexus','Jeep','Volvo','Other']

export const MODEL_SUGS = {Toyota:['Hilux','Camry','Corolla','RAV4','LandCruiser','LandCruiser 200','Prado','HiAce','Kluger','Yaris','Aurion'],Ford:['Ranger','Falcon','Territory','Focus','Fiesta','Escape','Explorer','Mustang','Transit'],Holden:['Commodore','Colorado','Trax','Captiva','Cruze','Astra','Barina','Trailblazer'],Mazda:['CX-5','CX-3','CX-9','CX-7','Mazda3','Mazda6','BT-50','MX-5','RX-7','RX-8'],Hyundai:['i30','Tucson','Santa Fe','i20','Accent','Elantra','Sonata','ix35','Kona'],Kia:['Sportage','Cerato','Rio','Sorento','Carnival','Stinger','Seltos'],Mitsubishi:['Triton','ASX','Outlander','Eclipse Cross','Pajero','Lancer'],Nissan:['Navara','X-Trail','Patrol','Pathfinder','Qashqai','Pulsar','Skyline'],Subaru:['Forester','Outback','Impreza','Liberty','WRX','BRZ','XV'],Honda:['CR-V','HR-V','Jazz','Civic','Accord'],Volkswagen:['Golf','Polo','Tiguan','Passat','Amarok'],BMW:['3 Series','5 Series','7 Series','X3','X5','X1'],'Mercedes-Benz':['C-Class','E-Class','S-Class','GLC','GLE','A-Class'],'Land Rover':['Discovery','Range Rover','Defender'],Isuzu:['D-Max','MU-X'],Suzuki:['Swift','Vitara','Jimny'],Lexus:['RX','NX','GX','IS'],Jeep:['Wrangler','Cherokee','Grand Cherokee'],Volvo:['XC90','XC60','XC40']}

// Common spelling/abbreviation variants → canonical make.
const MAKE_ALIASES = { vw: 'Volkswagen', volkswagon: 'Volkswagen', mercedes: 'Mercedes-Benz', merc: 'Mercedes-Benz', benz: 'Mercedes-Benz', 'mercedes benz': 'Mercedes-Benz', landrover: 'Land Rover', chevrolet: 'Holden', chev: 'Holden', vauxhall: 'Holden' }

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A word-boundary regex that tolerates the token's own spaces/hyphens being
// written either way (e.g. "CX-5" / "CX 5" / "CX5", "3 Series" / "3series").
const tokenRe = tok => new RegExp('\\b' + escapeRe(tok.toLowerCase()).replace(/[-\s]+/g, '[-\\s]?') + '\\b')

// Parse make / model / year out of a free-text part title. Best-effort: returns
// blanks for anything it can't confidently match.
export function parseVehicle(title = '') {
  const t = (title || '').toLowerCase()

  // ── make: earliest confident match wins (handles titles naming two vehicles) ──
  let make = '', makeIdx = Infinity
  for (const mk of MAKES) {
    if (mk === 'Other') continue
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

  // ── year: first plausible 1950–2049 four-digit run (start of a range) ──
  const ym = title.match(/\b(19[5-9]\d|20[0-4]\d)\b/)
  return { make, model, year: ym ? ym[1] : '' }
}
