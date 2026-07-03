// Per-marketplace configuration. Everything country-specific keys off the store's
// marketplace (store.settings.marketplace), defaulting to Australia so existing
// stores are unaffected. eBay Trading site IDs: AU=15, US=0, UK=3.
export const MARKETPLACES = {
  EBAY_AU: { id: 'EBAY_AU', country: 'AU', label: 'Australia',      flag: '🇦🇺', ebaySiteId: 15, currency: 'AUD', currencySymbol: '$', locale: 'en-AU', weightUnit: 'g',  ebayDomain: 'ebay.com.au' },
  EBAY_US: { id: 'EBAY_US', country: 'US', label: 'United States',  flag: '🇺🇸', ebaySiteId: 0,  currency: 'USD', currencySymbol: '$', locale: 'en-US', weightUnit: 'oz', ebayDomain: 'ebay.com' },
  EBAY_GB: { id: 'EBAY_GB', country: 'GB', label: 'United Kingdom', flag: '🇬🇧', ebaySiteId: 3,  currency: 'GBP', currencySymbol: '£', locale: 'en-GB', weightUnit: 'g',  ebayDomain: 'ebay.co.uk' },
}

export const DEFAULT_MARKETPLACE = 'EBAY_AU'
export const MARKETPLACE_LIST = Object.values(MARKETPLACES)

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
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    if (tz.startsWith('America/')) return 'EBAY_US'
    if (tz.startsWith('Europe/London')) return 'EBAY_GB'
  } catch { /* fall through */ }
  return DEFAULT_MARKETPLACE
}
