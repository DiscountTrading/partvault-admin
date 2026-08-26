// Gemini transport for the AI features.
//
// Every AI operation in PartVault is metered, and Gemini runs roughly 18x
// cheaper than Claude for assessment and item-specifics work, so it is the
// default with a Claude fallback. This module is the wire protocol only:
// resolving a live model id (Google renames models faster than we redeploy,
// hence the cache and the probe), turning image URLs into inline parts, and the
// call itself — which returns token counts because the caller bills for them.
// The policy about WHEN to spend a credit stays with the caller.

let _geminiModelCache: { full?: string; lite?: string } | null = null
export async function resolveGeminiModel(wantLite = false): Promise<string> {
  if (_geminiModelCache) return (wantLite ? _geminiModelCache.lite : _geminiModelCache.full) || _geminiModelCache.full!
  const KEY = Deno.env.get('GEMINI_API_KEY')
  if (!KEY) throw new Error('GEMINI_API_KEY not set')
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}&pageSize=200`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Gemini ListModels HTTP ${res.status}: ${data?.error?.message || 'error'}`)
  const names: string[] = (data.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m: any) => String(m.name || '').replace(/^models\//, ''))
  const bad = /lite|pro|thinking|-exp|embedding|aqa|vision-|1\.0|1\.5|8b/i
  const full = names.find((n) => n === 'gemini-flash-latest')
    || names.filter((n) => /flash/i.test(n) && !bad.test(n)).sort().reverse()[0]
    || names.find((n) => /flash/i.test(n) && !/pro|embedding|aqa/i.test(n))
    || names.find((n) => /gemini/i.test(n))
  const lite = names.find((n) => n === 'gemini-flash-lite-latest')
    || names.filter((n) => /flash-lite/i.test(n) && !/-exp/i.test(n)).sort().reverse()[0]
    || full
  if (!full) throw new Error(`No usable Gemini model for this key (saw: ${names.slice(0, 12).join(', ') || 'none'})`)
  _geminiModelCache = { full, lite }
  return wantLite ? (lite || full) : full
}

// Convert an Anthropic-style content array (text + image url/base64 blocks) into
// Gemini `parts`. Gemini needs image BYTES inline, so URL images are fetched and
// base64-encoded here. An image that won't load is skipped, not fatal.
export async function toGeminiParts(content: any[]): Promise<any[]> {
  const parts: any[] = []
  for (const b of content) {
    if (b?.type === 'text') { parts.push({ text: b.text }); continue }
    if (b?.type === 'image') {
      const src = b.source || {}
      if (src.type === 'base64' && src.data) { parts.push({ inline_data: { mime_type: src.media_type || 'image/jpeg', data: src.data } }); continue }
      if (src.type === 'url' && src.url) {
        try {
          const r = await fetch(src.url)
          const buf = new Uint8Array(await r.arrayBuffer())
          let bin = ''; const CH = 0x8000
          for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH) as unknown as number[])
          const ct = r.headers.get('content-type') || ''
          parts.push({ inline_data: { mime_type: ct.startsWith('image/') ? ct : 'image/jpeg', data: btoa(bin) } })
        } catch (_) { /* skip */ }
      }
    }
  }
  return parts
}

// Call Gemini generateContent in JSON mode. Returns concatenated text + token
// usage, or throws (so the caller can fall back to Anthropic).
export async function callGemini(model: string, sys: string, content: any[], maxTokens = 1400): Promise<{ text: string; inTok: number; outTok: number }> {
  const KEY = Deno.env.get('GEMINI_API_KEY')
  if (!KEY) throw new Error('GEMINI_API_KEY not set')
  const parts = await toGeminiParts(content)
  const req = {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens, temperature: 0.2 },
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(`Gemini HTTP ${res.status}: ${data?.error?.message || 'error'}`)
  const cand = data.candidates?.[0]
  const fin = cand?.finishReason
  if (!cand || (fin && fin !== 'STOP' && fin !== 'MAX_TOKENS')) throw new Error(`Gemini stopped: ${fin || 'no candidate'}`)
  const text = (cand.content?.parts || []).map((p: any) => p.text || '').join('').trim()
  if (!text) throw new Error('Gemini empty response')
  const u = data.usageMetadata || {}
  return { text, inTok: u.promptTokenCount || 0, outTok: u.candidatesTokenCount || 0 }
}

// ── AI metering (shared scheme with ai-assess) ──────────────────────────────
// "ALL AI is metered": the specifics photo-fill costs 0.2 credits (0.4 on Opus)
// when the AI actually runs — cache hits and the heuristic passes are free.
// Peek-then-commit: check the allowance BEFORE calling the model, debit only
// after a successful response (a failed call charges nothing). Fail-open on any
// metering error so a hiccup never blocks a listing.
