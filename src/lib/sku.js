// Preview-only SKU renderer. The AUTHORITATIVE SKU always comes from the
// generate_next_sku() RPC (atomic store counter); this mirrors its token logic
// purely so the Settings editor can show a live example as the user types.
// Keep the token set in sync with the SQL function.

export const DEFAULT_SKU_TEMPLATE = '{YY}{MM}-{CAR}-{SEQ}'
export const DEFAULT_SKU_PAD = 3

export const SKU_TOKENS = [
  ['{YYYY}', 'Year, 4-digit'],
  ['{YY}', 'Year, 2-digit'],
  ['{MM}', 'Month'],
  ['{DD}', 'Day'],
  ['{CAR}', 'Make, 4 chars padded (e.g. TOYO)'],
  ['{MAKE}', 'Full make (e.g. TOYOTA)'],
  ['{SEQ}', 'Running store number'],
]

export function buildSkuPreview(template, pad = DEFAULT_SKU_PAD, { make = 'Toyota', seq = 1, date = new Date() } = {}) {
  const yyyy = String(date.getFullYear())
  const yy = yyyy.slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const cleanMake = (make || '').replace(/\s+/g, '').toUpperCase()
  const car = cleanMake ? cleanMake.slice(0, 4).padEnd(4, 'X') : ''
  let out = (template || DEFAULT_SKU_TEMPLATE)
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yy)
    .replaceAll('{MM}', mm)
    .replaceAll('{DD}', dd)
    .replaceAll('{CAR}', car)
    .replaceAll('{MAKE}', cleanMake)
    .replaceAll('{SEQ}', String(seq).padStart(Number(pad) || DEFAULT_SKU_PAD, '0'))
  return out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
}
