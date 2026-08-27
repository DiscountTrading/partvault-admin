// Item specifics: the decisions that fill an eBay listing's aspect fields.
//
// Pure. Pulled out of fillAspects in index.ts, which mixed these decisions with
// a taxonomy fetch and a vision-model call and so could not be exercised at all.
// Everything here is consequential in a way that is invisible until a listing is
// already live:
//
//   deriveAspect      picks the value for a named aspect from our own data. It
//     is the reason "Manufacturer Warranty" must not be filled with the make —
//     that aspect is a warranty PERIOD, and a listing that offers "Ford" months
//     of warranty is a listing eBay rejects or a buyer disputes.
//   fillRequiredNeutral  is the last resort for a REQUIRED aspect. If it picks
//     nothing the publish fails; if it picks a wrong-but-valid value the listing
//     goes live stating something untrue about the part.
//   compatibilityAspects  expands a fitment list into the Compatible Make/Model/
//     Year multi-value aspects — the fields eBay search actually matches on, so
//     an over-wide year range is a part surfacing for cars it does not fit.
//
// The eBay call and the AI call stay in index.ts; this module decides, it does
// not fetch.

export type AspectSpec = {
  name: string
  required: boolean
  selectionOnly: boolean
  allowed: string[]
}

export type Aspects = Record<string, string[]>

// Values eBay itself offers to mean "no meaningful answer". Preferred over
// picking allowed[0] blindly, which states something specific and untrue.
export const NEUTRAL_VALUES = [
  'unbranded', 'does not apply', 'unknown', 'not specified', 'unspecified', 'other', 'na', 'n/a',
]

// eBay matches an allowed value case-insensitively but stores it verbatim, so a
// case mismatch is rejected. Always write back the string eBay gave us.
export const inAllowedOf = (allowed: string[], val: unknown): string | undefined =>
  allowed.find((v) => v.toLowerCase() === String(val).toLowerCase())

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]

// eBay's get_item_aspects_for_category response → the shape the passes below
// use. Tolerant of missing sections: an aspect list we cannot read must leave
// the caller with an empty list, never a throw mid-publish.
export function parseAspectSpecs(aData: any): AspectSpec[] {
  return (aData?.aspects || []).map((a: any) => ({
    name: a.localizedAspectName as string,
    required: !!a.aspectConstraint?.aspectRequired,
    selectionOnly: a.aspectConstraint?.aspectMode === 'SELECTION_ONLY',
    allowed: (a.aspectValues || []).map((v: any) => v.localizedValue).filter(Boolean) as string[],
  })).filter((s: AspectSpec) => !!s.name)
}

// Which end/side of the car the part came off, read from the title. Returned as
// one comma-joined string because that is how eBay's Placement aspect is worded
// ("Front, Left"), not as a list.
export function placementFromTitle(title: unknown): string | null {
  const t = String(title || '').toLowerCase()
  const out: string[] = []
  if (/\bfront\b/.test(t)) out.push('Front')
  if (/\b(rear|back)\b/.test(t)) out.push('Rear')
  if (/\b(left|lh|l\/h|driver)\b/.test(t)) out.push('Left')
  if (/\b(right|rh|r\/h|passenger)\b/.test(t)) out.push('Right')
  return out.length ? out.join(', ') : null
}

// The value our own structured data can supply for an aspect, or null to leave
// it for the AI pass.
export function deriveAspect(name: string, part: any): string | null {
  const n = String(name || '').toLowerCase()
  // "Manufacturer Warranty" contains "manufacturer" but is a warranty PERIOD,
  // not the brand — never fill it with the make. applyWarranty owns it.
  if (/\b(brand|manufacturer)\b/.test(n) && !/part/.test(n) && !/warrant/.test(n)) return part.make || null
  if (/make/.test(n)) return part.make || null
  if (/model/.test(n)) return part.model || null
  if (/year/.test(n)) return part.year ? String(part.year) : null
  if (/(part\s*number|^mpn$|oe[\/\s]?oem|reference|interchange|supersed)/.test(n)) return part.part_number || null
  if (/placement/.test(n)) return placementFromTitle(part.title)
  // NB: do NOT derive "Type" from our internal category — eBay's Type aspect
  // means the product type (e.g. "Headlight Bulb"), not our taxonomy. Let the
  // AI fill it from the photo instead.
  return null
}

// Pass 1 — fill from our own structured part/car data. Mutates `aspects`.
// Never overwrites a value already present: the caller's earlier passes and the
// user's overrides both outrank a derivation.
export function applyDerived(specs: AspectSpec[], part: any, aspects: Aspects): Aspects {
  for (const s of specs) {
    if (aspects[s.name]) continue
    const d = deriveAspect(s.name, part)
    if (!d) continue
    if (!s.selectionOnly || !s.allowed.length) aspects[s.name] = [d]
    else { const m = inAllowedOf(s.allowed, d); if (m) aspects[s.name] = [m] }
  }
  return aspects
}

// The aspects still unfilled, capped, in the order eBay listed them. This is
// what the vision model is asked about — a cap because the prompt carries every
// allowed value for every SELECTION_ONLY aspect and a large category would
// otherwise blow the context.
export function aspectsToAsk(specs: AspectSpec[], aspects: Aspects, limit = 30): AspectSpec[] {
  return specs.filter((s) => !aspects[s.name]).slice(0, limit)
}

// The aspect list as the model is shown it. Split out because a silently
// truncated allowed-value list is how a "choose one" answer comes back invalid.
export function aspectPromptList(todo: AspectSpec[]): string {
  return todo.map((s) => s.selectionOnly && s.allowed.length
    ? `- ${s.name} (choose exactly one, verbatim: ${s.allowed.slice(0, 40).join(' | ')})`
    : `- ${s.name} (free text, max 60 chars)`).join('\n')
}

// Pass 2 result → aspects. A SELECTION_ONLY answer that is not on the list is
// DROPPED rather than coerced: eBay refuses the publish either way, and a
// dropped aspect can still be caught by the required-value fallback below.
export function applyAiAspects(todo: AspectSpec[], aspMap: any, aspects: Aspects): Aspects {
  for (const s of todo) {
    const v = aspMap?.[s.name]
    if (!v || typeof v !== 'string') continue
    if (s.selectionOnly && s.allowed.length) { const m = inAllowedOf(s.allowed, v); if (m) aspects[s.name] = [m] }
    else aspects[s.name] = [v.slice(0, 65)]
  }
  return aspects
}

// The donor vehicle always belongs in the fitment — the AI adds models on top of
// it, and the one car we know for certain the part came off must never be the
// one dropped. Returns a new list.
export function ensureDonorFitment(fitmentList: any[], part: any): any[] {
  if (!part?.make || !part?.model) return fitmentList
  const dl = (s: any) => String(s || '').toLowerCase()
  if (fitmentList.some((f: any) => dl(f.make) === dl(part.make) && dl(f.model) === dl(part.model))) return fitmentList
  const ys = String(part.year || '').match(/\d{4}/g) || []
  return [{
    make: part.make,
    model: part.model,
    yearFrom: ys[0] ? +ys[0] : undefined,
    yearTo: ys[1] ? +ys[1] : (ys[0] ? +ys[0] : undefined),
    trim: '',
    engine: '',
  }, ...fitmentList]
}

// The model years one fitment row covers. Bounded at 40 per row: the year range
// comes from a language model, and a junk yearTo (2500, or a typo'd 20155) would
// otherwise expand to hundreds of entries and crowd out every other vehicle in
// the 200-product compatibility payload. A missing yearTo means the one year,
// never an open range. Shared with the Parts Compatibility builder in index.ts
// so the two can never disagree about what a fitment row means.
export const MAX_YEARS_PER_FITMENT = 40
export function expandYears(f: any): string[] {
  const out: string[] = []
  const yf = +f?.yearFrom, yt = +f?.yearTo || yf
  if (yf) for (let y = yf; y <= yt && y - yf < MAX_YEARS_PER_FITMENT; y++) out.push(String(y))
  return out
}

// Compatible-vehicle item specifics (multi-value) from the fitment.
//
// ⚠ CAPPED AT 30 VALUES PER ASPECT, and for Compatible Year that cap is
// reachable: three or four vehicles with real production runs exceed 30 model
// years easily. What gets dropped is whatever falls last in FITMENT ORDER, which
// is the order the model happened to answer in — so a part can list "Commodore"
// under Compatible Model while the Commodore's own years are the ones cut.
// Left as-is deliberately: 30 may be eBay's own per-aspect value limit, and
// raising it blind risks the publish being rejected outright. Pinned in
// tests/aspects.test.mjs. Needs a decision, not a guess.
//
// This is the item-specifics copy, NOT the field eBay search matches a buyer's
// car against — that is the Parts Compatibility list (product_compatibility,
// built per-vehicle in index.ts and capped at 200 products), which is unaffected
// by this cap. That is what keeps this a display defect rather than a lost sale.
export const MAX_ASPECT_VALUES = 30
export function compatibilityAspects(specs: AspectSpec[], fitmentList: any[], aspects: Aspects): Aspects {
  if (!fitmentList.length) return aspects
  const makes = uniq(fitmentList.map((f: any) => f.make))
  const models = uniq(fitmentList.map((f: any) => f.model))
  const years = uniq(fitmentList.flatMap(expandYears))
  for (const s of specs) {
    const nlc = s.name.toLowerCase()
    if (!/compat/.test(nlc)) continue
    let vals = /make/.test(nlc) ? makes : /model/.test(nlc) ? models : /year/.test(nlc) ? years : []
    if (s.allowed.length) vals = vals.map((v) => inAllowedOf(s.allowed, v)).filter(Boolean) as string[]
    if (vals.length) aspects[s.name] = uniq([...(aspects[s.name] || []), ...vals]).slice(0, MAX_ASPECT_VALUES)
  }
  return aspects
}

// Pass 3 — a REQUIRED aspect with nothing in it fails the publish, so every one
// gets a value. Order matters: brand and part number have a right answer we
// hold, everything else takes eBay's own "no meaningful answer" option before
// it takes the first item on the list.
export function fillRequiredNeutral(specs: AspectSpec[], part: any, aspects: Aspects): Aspects {
  for (const s of specs) {
    if (aspects[s.name] || !s.required) continue
    const nlc = s.name.toLowerCase()
    if (/\b(brand|manufacturer)\b/.test(nlc) && !/part/.test(nlc) && !/warrant/.test(nlc))
      aspects[s.name] = [s.allowed.length ? (inAllowedOf(s.allowed, 'Unbranded') || s.allowed[0]) : (part.make || 'Unbranded')]
    else if (/part\s*number|mpn/i.test(nlc)) aspects[s.name] = [part.part_number || 'Does Not Apply']
    else if (s.allowed.length) aspects[s.name] = [s.allowed.find((v: string) => NEUTRAL_VALUES.includes(v.toLowerCase())) || s.allowed[0]]
    else aspects[s.name] = ['Unbranded']
  }
  return aspects
}

// Warranty aspect(s) — a warranty PERIOD, set deterministically and never
// derived from the make/brand. Uses the store default (Settings → Listing
// Defaults) or "1 Month" when unset. Authoritative: overrides anything the
// passes above may have put here. For a "choose one" aspect only a listed value
// is written (1 Month ≈ 30 Days), so eBay never gets an invalid term; if nothing
// matches, whatever valid value is already there is left alone.
export function applyWarranty(specs: AspectSpec[], aspects: Aspects, listingDefaults: any = {}): Aspects {
  const warrantyVal = String(listingDefaults?.warranty || '').trim() || '1 Month'
  for (const s of specs) {
    if (!/warrant/i.test(s.name)) continue
    if (s.selectionOnly && s.allowed.length) {
      const m = inAllowedOf(s.allowed, warrantyVal)
        || (/1\s*month|30\s*day/i.test(warrantyVal) ? s.allowed.find((v: string) => /1\s*month|30\s*day/i.test(v)) : undefined)
      if (m) aspects[s.name] = [m]
    } else {
      aspects[s.name] = [warrantyVal]
    }
  }
  return aspects
}

// The user's corrections in the listing preview are authoritative and beat every
// pass above, INCLUDING the required-value fallback — a blank override means
// "eBay should not receive this aspect", not "fall back to Unbranded". Runs
// outside the try in fillAspects so a failed taxonomy fetch still honours them.
export function applyOverrides(part: any, aspects: Aspects, fitmentList: any[]): { aspects: Aspects; fitmentList: any[] } {
  const ov = part?.ebay_overrides || {}
  if (ov.specifics && typeof ov.specifics === 'object') {
    for (const [k, v] of Object.entries(ov.specifics)) {
      if (v == null || v === '') delete aspects[k]
      else aspects[k] = [String(v)]
    }
  }
  return { aspects, fitmentList: Array.isArray(ov.fitment) ? ov.fitment : fitmentList }
}

// The vision prompt for pass 2, verbatim. Kept beside the aspect logic it drives
// because the two have to agree: aspectPromptList formats the "choose exactly
// one, verbatim" lines this prompt tells the model to honour, and applyAiAspects
// DROPS any answer that is not on the list. Change one and read the other.
export const SPECIFICS_SYSTEM_PROMPT = `You are an expert Australian auto-parts eBay lister. Identify the part from the PHOTOS first — the provided Category is only a hint and may be wrong; trust the photos if they disagree. From the part photos and the known donor vehicle, do TWO things and return JSON only:\n{"aspects": {<aspectName>: <value>}, "fitment": [{"make":"","model":"","yearFrom":2012,"yearTo":2017,"trim":"","engine":""}]}\ntrim and engine are optional — include them only when the part is specific to that trim/engine; leave "" otherwise.\nASPECTS: fill in as MANY of the listed aspects as you reasonably can — do not leave fields blank when a sensible value is determinable. Use the photos, the identified part type, the donor vehicle, and standard knowledge of this kind of used auto part. Infer reasonable values for things like Type, Placement, Brand (the OEM make, or "Unbranded" for generic), Colour, Material, Surface Finish, Country/Region of Manufacture, and — for a clearly identified part — typical specs (e.g. the Voltage/Wattage/base size of a known bulb, the standard size of a known component). For "choose one" aspects return ONE listed option verbatim (pick the closest match), otherwise omit. Read any dimension, size, wattage, voltage, bulb base or part number that is PRINTED or visible in the photos and fill the matching aspect (Item Diameter, Item Length, Bulb Size, Voltage, Wattage, etc.). Do NOT fabricate a precise measurement, exact part number, or warranty term you cannot see or safely infer. Leave an aspect blank ONLY when you genuinely cannot determine a sensible value.\nFITMENT — list the vehicles this part actually fits (confidence is about whether it genuinely fits, NOT about how few you list):\n• VEHICLE-SPECIFIC parts (body panels, light assemblies, looms, ECUs, trim, mirrors): list only vehicles you are confident share the IDENTICAL part (same OEM/interchange number) — the donor vehicle plus platform-shared siblings you are sure about. Omit uncertain ones.\n• STANDARDISED / UNIVERSAL parts (a globe/bulb of a standard base such as H1/H4/H7/H11/HB3/9005, a fuse, a wiper blade of a given size, a standard spin-on oil filter, a common belt): these genuinely fit MANY vehicles. First identify the exact specification, then list the common Australian-market vehicles that use that spec — up to 20 popular models with realistic year ranges. This is accurate, not guessing, so do NOT restrict it to just the donor car.\nNever list a vehicle that does not actually take this part. Return an empty array only if you truly cannot tell.`
