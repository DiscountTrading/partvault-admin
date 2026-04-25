import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PROXY = 'https://partvault-proxy.leap00.workers.dev'
const APP_ID = 'Discount-PartVaul-PRD-36c135696-64f7f7bf'
const CHUNK_SIZE = 20 // items per invocation — well within Supabase CPU limit
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh if expires within 5 min
const FUNCTION_TIMEOUT_MS = 25 * 1000 // return early at 25s before Supabase kills at ~30s

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // Timeout guard — return a controlled 408 response before Supabase's
  // ~30 second CPU/wall-clock limit kills the function with no response,
  // which would cause the frontend to see a CORS-shaped network failure.
  // The frontend sees { error: 'timeout', retry: true } and retries the
  // same chunk after a short pause.
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<Response>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`Function approaching timeout at ${FUNCTION_TIMEOUT_MS}ms — returning early for retry`)
      resolve(new Response(JSON.stringify({ error: 'timeout', retry: true }), {
        status: 408,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      }))
    }, FUNCTION_TIMEOUT_MS)
  })

  try {
    const response = await Promise.race([handleRequest(req), timeoutPromise])
    if (timeoutId) clearTimeout(timeoutId)
    return response
  } catch (e: any) {
    if (timeoutId) clearTimeout(timeoutId)
    console.error('Unhandled error:', e.message)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
})

async function handleRequest(req: Request): Promise<Response> {

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  try {
    const body = await req.json()
    const { action, storeId, jobId, retryIds } = body

    // ── HELPERS ────────────────────────────────────────────────────────────

    /**
     * getToken — returns a valid access token, refreshing if needed.
     * Reads from stores.settings.ebayOAuth: { accessToken, refreshToken, expiresAt }
     * If access token has expired (or expires within 5 min), uses refresh token
     * to get a fresh one via the Cloudflare proxy /ebay/refresh route, then
     * persists the new token + expiry back to Supabase.
     */
    const getToken = async () => {
      const { data: store, error } = await sb.from('stores').select('settings').eq('id', storeId).single()
      if (error) throw new Error('Store not found')

      const oauth = store?.settings?.ebayOAuth
      const certId = store?.settings?.ebayCreds?.certId || ''
      const appId = store?.settings?.ebayCreds?.appId || APP_ID

      if (!oauth?.accessToken) {
        throw new Error('No eBay token — please reconnect in Settings')
      }

      // Check if token is still valid (with buffer)
      const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0
      const needsRefresh = !expiresAt || (expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS)

      if (!needsRefresh) {
        return { token: oauth.accessToken, certId }
      }

      // Refresh required
      if (!oauth.refreshToken) {
        throw new Error('Access token expired and no refresh token available — please reconnect in Settings')
      }

      console.log(`Token expires at ${oauth.expiresAt}, refreshing...`)

      const refreshRes = await fetch(`${PROXY}/ebay/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: oauth.refreshToken,
          appId,
          certId,
        }),
      })
      const refreshData = await refreshRes.json()

      if (!refreshData.access_token) {
        throw new Error(`Token refresh failed: ${refreshData.error_description || refreshData.error || 'unknown error'} — please reconnect in Settings`)
      }

      const newExpiresAt = new Date(Date.now() + (refreshData.expires_in * 1000)).toISOString()
      const newOAuth = {
        ...oauth,
        accessToken: refreshData.access_token,
        expiresAt: newExpiresAt,
        expiresIn: refreshData.expires_in,
      }

      const merged = { ...store.settings, ebayOAuth: newOAuth }
      const { error: updateErr } = await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      if (updateErr) {
        console.error('Failed to persist refreshed token:', updateErr.message)
      } else {
        console.log(`Token refreshed successfully, new expiry: ${newExpiresAt}`)
      }

      return { token: refreshData.access_token, certId }
    }

    const trading = async (token: string, certId: string, callName: string, xmlBody: string) => {
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

    const getTag = (xml: string, tag: string) =>
      xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))?.[1]?.trim() ?? ''

    const getTotalPages = (xml: string) =>
      parseInt(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? '1')

    const getItemIds = (xml: string): string[] =>
      [...xml.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map(m => m[1])

    const fetchAllIds = async (token: string, certId: string, listType: string): Promise<string[]> => {
      const xml1 = await trading(token, certId, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${listType}><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination></${listType}>
</GetMyeBaySellingRequest>`)
      // Detect auth failure: eBay returns Success with empty list when token is bad
      const ack = getTag(xml1, 'Ack')
      const errCode = getTag(xml1, 'ErrorCode')
      if (ack === 'Failure' || errCode) {
        const longMsg = getTag(xml1, 'LongMessage') || 'eBay API error'
        throw new Error(`eBay API: ${longMsg}`)
      }
      const totalPages = getTotalPages(xml1)
      const ids: string[] = getItemIds(xml1)
      for (let p = 2; p <= Math.min(totalPages, 50); p++) {
        const xml = await trading(token, certId, 'GetMyeBaySelling', `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <${listType}><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${p}</PageNumber></Pagination></${listType}>
</GetMyeBaySellingRequest>`)
        getItemIds(xml).forEach(id => ids.push(id))
      }
      return [...new Set(ids)]
    }

    const buildPart = (xml: string, storeId: string) => {
      const itemId = getTag(xml, 'ItemID')
      const listingStatus = getTag(xml, 'ListingStatus')
      const sellingState = getTag(xml, 'SellingState')
      const status = (sellingState === 'EndedWithSales' || sellingState === 'Sold')
        ? 'Sold' : listingStatus === 'Active' ? 'Listed' : 'Archived'
      const priceStr = getTag(xml, 'ConvertedCurrentPrice') || getTag(xml, 'BuyItNowPrice') || getTag(xml, 'CurrentPrice')
      const descRaw = getTag(xml, 'Description')
      const photos = [...xml.matchAll(/<PictureURL>(.*?)<\/PictureURL>/g)].map(m => m[1]).slice(0, 8)
      return {
        store_id: storeId,
        sku: itemId,
        ebay_item_id: itemId,
        title: getTag(xml, 'Title'),
        status,
        list_price: parseFloat(priceStr) || 0,
        description: descRaw.replace(/<[^>]*>/g, '').trim().substring(0, 2000),
        condition: getTag(xml, 'ConditionDisplayName') || 'Used – Good',
        photos,
        ebay_category_id: getTag(xml, 'CategoryID'),
        costs: {},
      }
    }

    // ── STATUS ─────────────────────────────────────────────────────────────
    if (action === 'status') {
      const { data: job } = await sb.from('import_jobs').select('*').eq('id', jobId).single()
      return new Response(JSON.stringify(job ?? { error: 'Job not found' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // ── CANCEL ─────────────────────────────────────────────────────────────
    if (action === 'cancel') {
      await sb.from('import_jobs').update({ status: 'cancelled' }).eq('id', jobId)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // ── START — fetch all IDs, create job, return immediately ──────────────
    if (action === 'start') {
      const { token, certId } = await getToken()

      const activeIds = await fetchAllIds(token, certId, 'ActiveList')
      const soldIds = await fetchAllIds(token, certId, 'SoldList')
      const allIds = [...new Set([...activeIds, ...soldIds])]

      const { data: job, error: jobErr } = await sb.from('import_jobs').insert({
        store_id: storeId,
        status: 'running',
        total_ids: allIds.length,
        imported_count: 0,
        skipped_count: 0,
        failed_count: 0,
        all_item_ids: allIds,
        all_item_statuses: {},
        failed_reasons: {},
        batch_offset: 0,
        current_item: 'Ready to process...',
      }).select().single()

      if (jobErr) throw new Error(`Failed to create job: ${jobErr.message}`)

      return new Response(JSON.stringify({ jobId: job.id, totalIds: allIds.length, needsProcessing: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    // ── PROCESS CHUNK — called repeatedly by frontend until done ───────────
    if (action === 'process_chunk') {
      const { data: job, error: jobErr } = await sb.from('import_jobs')
        .select('*').eq('id', jobId).single()

      if (jobErr || !job) throw new Error('Job not found')
      if (job.status === 'cancelled') {
        return new Response(JSON.stringify({ status: 'cancelled' }), {
          headers: { ...CORS, 'Content-Type': 'application/json' }
        })
      }

      const { token, certId } = await getToken()

      const allIds: string[] = Array.isArray(job.all_item_ids) ? job.all_item_ids : []
      const offset: number = job.batch_offset || 0
      const chunk = allIds.slice(offset, offset + CHUNK_SIZE)

      if (chunk.length === 0) {
        await sb.from('import_jobs').update({
          status: 'completed',
          current_item: `✓ Complete — ${job.imported_count} imported, ${job.skipped_count} skipped, ${job.failed_count} failed`,
        }).eq('id', jobId)
        return new Response(JSON.stringify({ status: 'completed', job }), {
          headers: { ...CORS, 'Content-Type': 'application/json' }
        })
      }

      let imported = job.imported_count || 0
      let skipped = job.skipped_count || 0
      let failed = job.failed_count || 0
      const failedReasons: Record<string, string> = job.failed_reasons || {}
      const allStatuses: Record<string, string> = job.all_item_statuses || {}

      for (const itemId of chunk) {
        try {
          const { data: existing } = await sb.from('parts')
            .select('id').eq('store_id', storeId).eq('sku', itemId).maybeSingle()

          if (existing) {
            skipped++
            allStatuses[itemId] = 'skipped'
            continue
          }

          const xml = await trading(token, certId, 'GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`)

          if (!xml.includes('<Ack>Success</Ack>') && !xml.includes('<Ack>Warning</Ack>')) {
            throw new Error(getTag(xml, 'LongMessage') || 'eBay API error')
          }

          const part = buildPart(xml, storeId)
          const { error } = await sb.from('parts').insert(part)

          if (error?.code === '23505') {
            skipped++
            allStatuses[itemId] = 'skipped'
          } else if (error) {
            throw error
          } else {
            imported++
            allStatuses[itemId] = part.status
          }
        } catch (e: any) {
          failed++
          failedReasons[itemId] = e.message
          allStatuses[itemId] = 'failed'
        }
      }

      const newOffset = offset + CHUNK_SIZE
      const isComplete = newOffset >= allIds.length

      await sb.from('import_jobs').update({
        imported_count: imported,
        skipped_count: skipped,
        failed_count: failed,
        failed_reasons: failedReasons,
        all_item_statuses: allStatuses,
        batch_offset: newOffset,
        current_item: isComplete
          ? `✓ Complete — ${imported} imported, ${skipped} skipped`
          : `Processing ${Math.min(newOffset, allIds.length)} of ${allIds.length}...`,
        status: isComplete ? 'completed' : 'running',
      }).eq('id', jobId)

      return new Response(JSON.stringify({
        status: isComplete ? 'completed' : 'running',
        imported, skipped, failed,
        offset: newOffset,
        total: allIds.length,
        isComplete,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── RECONCILE ──────────────────────────────────────────────────────────
    if (action === 'reconcile') {
      const { token, certId } = await getToken()
      const ebayIds = await fetchAllIds(token, certId, 'ActiveList')
      const ebaySet = new Set(ebayIds)

      const { data: listedParts } = await sb.from('parts')
        .select('id, sku, title, ebay_item_id').eq('store_id', storeId).eq('status', 'Listed')

      const { data: allParts } = await sb.from('parts')
        .select('ebay_item_id').eq('store_id', storeId).not('ebay_item_id', 'is', null)

      const allPvIds = new Set((allParts ?? []).map((p: any) => p.ebay_item_id))
      const pvListedIds = new Set((listedParts ?? []).filter((p: any) => p.ebay_item_id).map((p: any) => p.ebay_item_id))
      const missingIds = ebayIds.filter(id => !allPvIds.has(id))
      const staleParts = (listedParts ?? []).filter((p: any) => p.ebay_item_id && !ebaySet.has(p.ebay_item_id))

      if (staleParts.length > 0) {
        await sb.from('parts')
          .update({ reconcile_flagged: true, reconcile_flagged_at: new Date().toISOString() })
          .in('id', staleParts.map((p: any) => p.id))
      }

      const { data: lastJob } = await sb.from('import_jobs')
        .select('id, failed_reasons, failed_count').eq('store_id', storeId)
        .order('updated_at', { ascending: false }).limit(1).maybeSingle()

      const failedReasons: Record<string, string> = lastJob?.failed_reasons ?? {}
      const failedItems = Object.entries(failedReasons).map(([itemId, reason]) => ({ itemId, reason }))

      return new Response(JSON.stringify({
        ebayActiveCount: ebayIds.length,
        pvListedCount: pvListedIds.size,
        missingCount: missingIds.length,
        missingIds: missingIds.slice(0, 50),
        staleCount: staleParts.length,
        staleParts: staleParts.map((p: any) => ({ id: p.id, sku: p.sku, title: p.title, ebayItemId: p.ebay_item_id })),
        failedCount: failedItems.length,
        failedItems,
        lastJobId: lastJob?.id ?? null,
        reconciledAt: new Date().toISOString(),
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── RETRY ──────────────────────────────────────────────────────────────
    if (action === 'retry') {
      const { token, certId } = await getToken()
      const ids: string[] = retryIds ?? []
      if (!ids.length) throw new Error('No retry IDs provided')

      let imported = 0, failed = 0
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
          const part = buildPart(xml, storeId)
          const { error } = await sb.from('parts').upsert(part, { onConflict: 'store_id,sku' })
          if (error) throw error
          imported++
        } catch (e: any) {
          failed++
          failedReasons[itemId] = e.message
        }
      }

      const { data: lastJob } = await sb.from('import_jobs').select('id, failed_reasons')
        .eq('store_id', storeId).order('updated_at', { ascending: false }).limit(1).maybeSingle()

      if (lastJob) {
        const updated = { ...(lastJob.failed_reasons ?? {}) }
        for (const id of ids) {
          if (!failedReasons[id]) delete updated[id]
          else updated[id] = failedReasons[id]
        }
        await sb.from('import_jobs')
          .update({ failed_reasons: updated, failed_count: Object.keys(updated).length })
          .eq('id', lastJob.id)
      }

      return new Response(JSON.stringify({ imported, failed, failedReasons }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      })
    }

    throw new Error(`Unknown action: ${action}`)

  } catch (e: any) {
    console.error('Edge function error:', e.message)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }
}
