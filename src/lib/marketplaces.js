// Per-marketplace configuration. Everything country-specific keys off the store's
// marketplace (store.settings.marketplace), defaulting to Australia so existing
// stores are unaffected. eBay Trading site IDs: AU=15, US=0, UK=3.
export const MARKETPLACES = {
  EBAY_AU: { id: 'EBAY_AU', country: 'AU', label: 'Australia',      flag: '🇦🇺', ebaySiteId: 15, currency: 'AUD', currencySymbol: '$', locale: 'en-AU', weightUnit: 'g',  ebayDomain: 'ebay.com.au' },
  EBAY_US: { id: 'EBAY_US', country: 'US', label: 'United States',  flag: '🇺🇸', ebaySiteId: 0,  currency: 'USD', currencySymbol: '$', locale: 'en-US', weightUnit: 'oz', ebayDomain: 'ebay.com' },
  EBAY_GB: { id: 'EBAY_GB', country: 'GB', label: 'United Kingdom', flag: '🇬🇧', ebaySiteId: 3,  currency: 'GBP', currencySymbol: '£', locale: 'en-GB', weightUnit: 'g',  ebayDomain: 'ebay.co.uk' },
  EBAY_CA: { id: 'EBAY_CA', country: 'CA', label: 'Canada',         flag: '🇨🇦', ebaySiteId: 2,  currency: 'CAD', currencySymbol: '$', locale: 'en-CA', weightUnit: 'g',  ebayDomain: 'ebay.ca' },
}

export const DEFAULT_MARKETPLACE = 'EBAY_AU'
export const MARKETPLACE_LIST = Object.values(MARKETPLACES)

// Active marketplace for the CURRENT store — set by App when the active store
// loads, read by display helpers (e.g. fmt in constants.js) so every money
// figure shows the store's currency without threading a store prop everywhere.
let _activeId = DEFAULT_MARKETPLACE
export function setActiveMarketplace(id) { _activeId = MARKETPLACES[id] ? id : DEFAULT_MARKETPLACE }
export function getActiveMarketplace() { return MARKETPLACES[_activeId] }

// Weight for display: metric marketplaces show kg/g; US shows lb/oz.
export function formatWeight(grams) {
  const g = Number(grams) || 0
  if (getActiveMarketplace().weightUnit === 'oz') {
    const totalOz = g / 28.3495
    const lb = Math.floor(totalOz / 16)
    const oz = Math.round(totalOz % 16)
    return lb ? `${lb} lb ${oz} oz` : `${Math.max(oz, 1)} oz`
  }
  return g >= 1000 ? `${(g / 1000).toFixed(g >= 10000 ? 0 : 1)} kg` : `${Math.round(g)} g`
}

// Resolve a store's marketplace config (tolerant of missing/legacy shapes).
export function marketplaceOf(store) {
  const id = store?.settings?.marketplace || store?.marketplace || DEFAULT_MARKETPLACE
  return MARKETPLACES[id] || MARKETPLACES[DEFAULT_MARKETPLACE]
}

// Currency formatting for the store's marketplace (e.g. $1,234.50 / £1,234.50).
export function formatMoney(amount, store) {
  const m = marketplaceOf(store)
  const n = Number(amount) || 0
  try { return new Intl.NumberFormat(m.locale, { style: 'currency', currency: m.currency }).format(n) }
  catch { return `${m.currencySymbol}${n.toFixed(2)}` }
}

// Best-guess marketplace from the browser, for pre-filling at store creation.
export function guessMarketplace() {
  try {
    const loc = (navigator.language || '').toLowerCase()
    if (loc.endsWith('-us') || loc === 'en-us') return 'EBAY_US'
    if (loc.endsWith('-gb') || loc === 'en-gb') return 'EBAY_GB'
    if (loc.endsWith('-au')) return 'EBAY_AU'
    if (loc.endsWith('-ca') || loc === 'fr-ca') return 'EBAY_CA'
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    if (tz.startsWith('America/Toronto') || tz.startsWith('America/Vancouver') || tz.startsWith('America/Edmonton') || tz.startsWith('America/Winnipeg')) return 'EBAY_CA'
    if (tz.startsWith('America/')) return 'EBAY_US'
    if (tz.startsWith('Europe/London')) return 'EBAY_GB'
  } catch { /* fall through */ }
  return DEFAULT_MARKETPLACE
}
