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
const EDGE_FN_VERSION         = '3.10.1-edge'
const CHUNK_SIZE              = 20
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const FUNCTION_TIMEOUT_MS     = 25 * 1000
const EBAY_TOKEN_URL          = 'https://api.ebay.com/identity/v1/oauth2/token'
const EBAY_SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.account.readonly'

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

  const parseTransactions = (xml: string): Array<{ itemId: string; title: string; salePrice: number; soldAt: string | null }> => {
    const results: Array<{ itemId: string; title: string; salePrice: number; soldAt: string | null }> = []
    for (const txMatch of xml.matchAll(/<Transaction>([\s\S]*?)<\/Transaction>/g)) {
      const txXml = txMatch[1]
      const itemSection = txXml.match(/<Item>([\s\S]*?)<\/Item>/)?.[1] ?? ''
      const itemId = getTag(itemSection, 'ItemID')
      if (!itemId) continue
      const title     = getTag(itemSection, 'Title')
      const salePrice = parseFloat(getTag(txXml, 'TransactionPrice')) || 0
      const soldAt    = getTag(txXml, 'PaidTime') || getTag(txXml, 'CreatedDate') || null
      results.push({ itemId, title, salePrice, soldAt })
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

  const fetchAllIds = async (token: string, certId: string, listType: string): Promise<string[]> => {
    const durationParam = listType === 'SoldList' ? '<DurationInDays>90</DurationInDays>' : ''
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

    let status    = 'active'
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
        const chunk = allIds.slice(offset, offset + CHUNK_SIZE)

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

        for (const itemId of chunk) {
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

            if (ebaySkuRaw) {
              const { data: existingPart } = await sb.from('parts')
                .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).maybeSingle()
              if (existingPart) {
                partId = existingPart.id
              } else {
                const { data: newPart, error: partErr } = await sb
                  .from('parts').insert(buildPartRow(xml, ebaySkuRaw)).select('id').single()
                if (partErr) throw partErr
                partId = newPart.id
              }
            } else {
              const { data: generatedSku, error: skuErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
              if (skuErr || !generatedSku) throw new Error(`SKU generation failed: ${skuErr?.message}`)
              const { data: newPart, error: partErr } = await sb
                .from('parts').insert(buildPartRow(xml, generatedSku as string)).select('id').single()
              if (partErr) throw partErr
              partId = newPart.id
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

        const newOffset  = offset + CHUNK_SIZE
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
      const allTransactions: Array<{ itemId: string; title: string; salePrice: number; soldAt: string | null }> = []
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

            const { data: part, error: partErr } = await sb.from('parts').insert({
              store_id:   storeId,
              sku:        `EBH-${tx.itemId}`,
              title:      detail?.Title || tx.title || `eBay Item ${tx.itemId}`,
              category,
              status:     'sold',
              sold_price: tx.salePrice,
              sold_date:  tx.soldAt || null,
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
              sold_at:             tx.soldAt || null,
              platform_data:       {},
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

    if (action === 'reconcile') {
      const { token, certId } = await getToken()
      const ebayIds = await fetchAllIds(token, certId, 'ActiveList')
      const ebaySet = new Set(ebayIds)

      const { data: activeListings } = await sb.from('listings')
        .select('id, part_id, platform_listing_id, platform_sku')
        .eq('store_id', storeId)
        .eq('platform', 'ebay')
        .eq('status', 'active')
        .eq('deferred_review', false)
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
        staleCount:      stale.length,
        staleListings:   stale.map((l: any) => ({
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

          if (ebaySkuRaw) {
            const { data: existingPart } = await sb.from('parts')
              .select('id').eq('store_id', storeId).eq('sku', ebaySkuRaw).maybeSingle()
            if (existingPart) {
              partId = existingPart.id
            } else {
              const { data: newPart, error: partErr } = await sb
                .from('parts').insert(buildPartRow(xml, ebaySkuRaw)).select('id').single()
              if (partErr) throw partErr
              partId = newPart.id
            }
          } else {
            const { data: generatedSku, error: skuErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId })
            if (skuErr || !generatedSku) throw new Error(`SKU generation failed: ${skuErr?.message}`)
            const { data: newPart, error: partErr } = await sb
              .from('parts').insert(buildPartRow(xml, generatedSku as string)).select('id').single()
            if (partErr) throw partErr
            partId = newPart.id
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

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }

      // Fetch account policies and location (use first of each)
      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])

      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      const merchantLocationKey  = locData.locations?.[0]?.merchantLocationKey

      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      if (!merchantLocationKey) throw new Error('No inventory location — go to Settings → eBay Inventory Location and set up your address first')

      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT',
        'Used – Good':      'USED_EXCELLENT',
        'Used – Fair':      'USED_EXCELLENT',
        'For Parts Only':   'FOR_PARTS_OR_NOT_WORKING',
        'Refurbished':      'SELLER_REFURBISHED',
      }

      const CATEGORY_ID: Record<string, string> = {
        'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
        'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
        'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
        'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
        'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
        'Other Car & Truck Parts':'9886','Legacy Items':'9886',
      }

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
              marketplaceId: 'EBAY_AU',
              format: 'FIXED_PRICE',
              listingDescription: part.notes || part.title,
              pricingSummary: { price: { value: String(part.list_price), currency: 'AUD' } },
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

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      }

      const [fpRes, ppRes, rpRes, locRes] = await Promise.all([
        fetch('https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_AU', { headers: ebayHeaders }),
        fetch('https://api.ebay.com/sell/inventory/v1/location', { headers: ebayHeaders }),
      ])
      const [fpData, ppData, rpData, locData] = await Promise.all([fpRes.json(), ppRes.json(), rpRes.json(), locRes.json()])
      const fulfillmentPolicyId  = fpData.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
      const paymentPolicyId      = ppData.paymentPolicies?.[0]?.paymentPolicyId
      const returnPolicyId       = rpData.returnPolicies?.[0]?.returnPolicyId
      const merchantLocationKey  = locData.locations?.[0]?.merchantLocationKey
      if (!fulfillmentPolicyId) throw new Error('No fulfillment policy on eBay account — set one up in eBay Seller Hub first')
      if (!paymentPolicyId)     throw new Error('No payment policy on eBay account — set one up in eBay Seller Hub first')
      if (!returnPolicyId)      throw new Error('No return policy on eBay account — set one up in eBay Seller Hub first')
      if (!merchantLocationKey) throw new Error('No inventory location — set it up in Settings → eBay first')

      // Auto-parts categories only accept "Used" (id 3000 = USED_EXCELLENT enum),
      // "For parts" (7000), "New" (1000), or Refurbished — NOT the graded
      // USED_GOOD/USED_ACCEPTABLE conditions (those are media-only).
      const CONDITION_MAP: Record<string, string> = {
        'Used – Excellent': 'USED_EXCELLENT', 'Used – Good': 'USED_EXCELLENT', 'Used – Fair': 'USED_EXCELLENT',
        'For Parts Only': 'FOR_PARTS_OR_NOT_WORKING', 'Refurbished': 'SELLER_REFURBISHED',
      }
      const CATEGORY_ID: Record<string, string> = {
        'Air & Fuel Delivery':'33549','Air Conditioning & Heating':'33542','Brakes & Brake Parts':'33559',
        'Engines & Engine Parts':'33612','Engine Cooling':'33599','Exhaust & Emission':'33605',
        'Exterior Parts':'33637','Ignition Systems':'33687','Interior Parts':'33694',
        'Lighting & Bulbs':'33707','Starters, Alternators & Wiring':'33572','Steering & Suspension':'33579',
        'Transmission & Drivetrain':'33726','Wheels, Tyres & Parts':'33743','Towing Parts':'180143',
        'Other Car & Truck Parts':'9886','Legacy Items':'9886',
      }

      // Store-wide image composition config: shared car/marketing images added
      // to every listing, with per-source budgets (eBay allows up to 24 images).
      const { data: storeRow } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const comp = storeRow?.settings?.imageComposition || {}
      const carMax = comp.carMax ?? 5
      const marketingMax = comp.marketingMax ?? 5
      const marketingImages: string[] = storeRow?.settings?.marketingImages || []
      const EBAY_MAX_IMAGES = 24

      const photoUrls = async (parentType: string, parentId: string) => {
        const { data } = await sb.from('photos')
          .select('url, ebay_url, is_primary, display_order')
          .eq('parent_type', parentType).eq('parent_id', parentId)
          .order('is_primary', { ascending: false }).order('display_order', { ascending: true })
        return (data || []).map((r: any) => r.url || r.ebay_url).filter(Boolean)
      }

      let published = 0
      let failed = 0
      const errors: any[] = []
      const results: any[] = []

      for (const part of parts) {
        try {
          // Blocking SKU gate
          let sku = part.sku
          if (!sku || !String(sku).trim()) {
            const { data: gen, error: genErr } = await sb.rpc('generate_next_sku', { p_store_id: storeId, p_car_make: part.make || null })
            if (genErr || !gen) throw new Error(`Cannot list without a SKU (auto-generation failed: ${genErr?.message || 'no SKU'})`)
            sku = gen as string
            await sb.from('parts').update({ sku }).eq('id', part.id)
          }

          const condition  = CONDITION_MAP[part.condition] || 'USED_GOOD'
          const categoryId = CATEGORY_ID[part.category]    || '9886'
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
          const aspects: Record<string, string[]> = {}
          if (part.make)  aspects['Make']  = [part.make]
          if (part.model) aspects['Model'] = [part.model]
          if (part.year)  aspects['Year']  = [String(part.year)]

          // eBay requires a package weight (grams). Use the part's weight, else
          // the store default (settings.defaultWeightG), else 1000g.
          const weightG = Math.round((+part.weight > 0 ? +part.weight : (storeRow?.settings?.defaultWeightG ?? 1000)))

          // 1. Create/replace the inventory item (PUT is idempotent)
          const invRes = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
            method: 'PUT', headers: ebayHeaders,
            body: JSON.stringify({
              product: { title: part.title, description: part.notes || part.title, aspects, ...(imageUrls.length ? { imageUrls } : {}) },
              condition,
              availability: { shipToLocationAvailability: { quantity: 1 } },
              packageWeightAndSize: { weight: { value: weightG, unit: 'GRAM' } },
            }),
          })
          if (!invRes.ok && invRes.status !== 204) {
            throw new Error(`Inventory item ${invRes.status}: ${(await invRes.text()).slice(0, 300)}`)
          }

          // 2. Create the offer — or reuse an existing one for this SKU
          const offerBody = {
            sku, marketplaceId: 'EBAY_AU', format: 'FIXED_PRICE',
            listingDescription: part.notes || part.title,
            pricingSummary: { price: { value: String(part.list_price), currency: 'AUD' } },
            categoryId, merchantLocationKey,
            listingPolicies: { fulfillmentPolicyId, paymentPolicyId, returnPolicyId },
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
              const getRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_AU`, { headers: ebayHeaders })
              offerId = (await getRes.json()).offers?.[0]?.offerId
              if (!offerId) throw new Error('Offer already exists but could not be retrieved')
              // keep price/policies current on the existing offer
              await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}`, { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(offerBody) })
            } else {
              throw new Error(msg || `Offer error ${offerRes.status}`)
            }
          }

          // 3. PUBLISH — this makes the listing LIVE on eBay
          const pubRes = await fetch(`https://api.ebay.com/sell/inventory/v1/offer/${offerId}/publish`, { method: 'POST', headers: ebayHeaders })
          const pubData = await pubRes.json()
          if (!pubRes.ok) throw new Error(pubData.errors?.[0]?.message || `Publish error ${pubRes.status}`)
          const listingId = pubData.listingId

          // 4. Record it — part now listed, listing row marked published
          await sb.from('parts').update({ status: 'listed' }).eq('id', part.id)
          await sb.from('listings').delete().eq('part_id', part.id).eq('platform', 'ebay').neq('status', 'sold')
          await sb.from('listings').insert({
            store_id: storeId, part_id: part.id, platform: 'ebay',
            platform_listing_id: listingId, platform_sku: sku, status: 'published',
            list_price: part.list_price, listed_at: new Date().toISOString(),
            platform_data: { offerId, listingId, sku }, photos: part.photos || [], photos_archived: false,
          })

          published++
          results.push({ partId: part.id, sku, listingId })
        } catch (e: any) {
          failed++
          errors.push({ partId: part.id, sku: part.sku, error: e.message })
          console.error(`Publish failed for ${part.sku}:`, e.message)
        }
      }

      return json({ published, failed, errors, results })
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

      const ebayHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
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
