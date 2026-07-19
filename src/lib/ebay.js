import { sb } from './supabase'

const EDGE_FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/ebay-import'

async function call(payload) {
  const { data: { session } } = await sb.auth.getSession()
  const res = await fetch(EDGE_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(payload),
  })
  const d = await res.json()
  if (!res.ok || d.error) { const e = new Error(d.error || 'eBay request failed'); e.data = d; throw e }
  return d
}

// Publish selected in-stock parts as live eBay listings.
export const publishListings = (storeId, partIds) => call({ action: 'publish_listings', storeId, partIds })
// End live listings for the selected parts; bin=true also removes the parts.
export const delistListings = (storeId, partIds, bin = false) => call({ action: 'delist_listings', storeId, partIds, bin })
// Read-only preview of the exact category + specifics + fitment a publish would send.
export const previewListing = (storeId, partId, overrides = {}) => call({ action: 'preview_listing', storeId, partId, ...overrides })
// Register the store's ship-from location with eBay (needed before the first publish).
export const setupEbayLocation = (storeId, address) => call({ action: 'setup_ebay_location', storeId, address })

// Does the current user have the 'publish' capability for this store?
export const canPublish = async (storeId) => {
  const { data } = await sb.rpc('has_permission', { p_store_id: storeId, p_capability: 'publish' })
  return !!data
}
