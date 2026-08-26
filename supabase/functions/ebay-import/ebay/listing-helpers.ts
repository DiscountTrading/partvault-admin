// Listing helpers: the small decisions that shape what goes to eBay.
//
// Pure except for hydrateVehicleFromCar, which takes its Supabase client as a
// parameter. Pulled out of index.ts so they can be exercised directly — these
// are consequential:
//
//   partTypeToken / categoryKeyFor  decide whether a category CORRECTION is
//     remembered. Get the key wrong and the store re-teaches eBay the same fix
//     forever; get it too loose and one correction leaks onto unrelated parts.
//   resolveShipping  decides the package weight and dimensions a listing quotes,
//     i.e. what the seller is charged when it sells.

export function buildDescription(part: any, _fitmentList: any[], footer: string): string {
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
export async function hydrateVehicleFromCar(sb: any, part: any): Promise<void> {
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
export function partTypeToken(part: any): string {
  let t = String(part.title || '').toLowerCase()
  const pn = String(part.part_number || '').toLowerCase().trim()
  if (pn) t = t.split(pn).join(' ')
  t = t.replace(/\b\d{4}(\s*[-/]\s*\d{2,4})?\b/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
  const strip = [part.make, part.model].filter(Boolean).join(' ').toLowerCase().split(/\s+/).filter(Boolean)
  const FILLER = new Set<string>(['front', 'rear', 'back', 'left', 'right', 'lh', 'rh', 'driver', 'passenger', 'side', 'genuine', 'oem', 'used', 'pre', 'owned', 'the', 'for', 'with', 'and', 'assembly', 'assy', 'part', 'parts', 'spare', 'set', 'pair', 'kit', 'unit', 'complete', ...strip])
  const words = t.split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w) && !/^\d+$/.test(w))
  return words.slice(0, 2).sort().join(' ') // sorted → order-independent (Headlight Halogen == Halogen Headlight)
}
export function categoryKeyFor(part: any): string {
  const cat = String(part.category || '').trim().toLowerCase()
  const sub = String(part.subcategory || '').trim().toLowerCase()
  const base = `${cat}|${sub}`
  return (!sub || sub === 'other') ? `${base}|${partTypeToken(part)}` : base
}
export function learnedCategoryFor(settings: any, part: any): { id: string; name: string } | null {
  const map = settings?.categoryLearning
  if (!map || typeof map !== 'object') return null
  const hit = map[categoryKeyFor(part)]
  return hit && hit.id ? { id: String(hit.id), name: String(hit.name || '') } : null
}

// Resolve the package weight (grams) + dimensions (cm) exactly as publish does:
// part weight > category preset > store default, guarded against zero/sub-gram.
export function resolveShipping(part: any, shipCats: any, shipDefW: number, shipDefDims: any) {
  const preset = shipCats[part.category] || {}
  const presetOrDefaultG = +preset.weightG > 0 ? +preset.weightG : shipDefW
  let weightG = Math.round(+part.weight > 0 ? +part.weight : presetOrDefaultG)
  if (!Number.isFinite(weightG) || weightG < 2) weightG = Math.round(presetOrDefaultG)
  const dimL = +preset.l > 0 ? +preset.l : (+shipDefDims.l > 0 ? +shipDefDims.l : 30)
  const dimW = +preset.w > 0 ? +preset.w : (+shipDefDims.w > 0 ? +shipDefDims.w : 20)
  const dimH = +preset.h > 0 ? +preset.h : (+shipDefDims.h > 0 ? +shipDefDims.h : 15)
  return { weightG, dimL, dimW, dimH }
}
