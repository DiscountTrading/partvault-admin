import { useState, useEffect } from 'react'
import { sb, FN_URL } from '../lib/supabase'
import { C, S, CATEGORY_NAMES } from '../lib/constants'

const AUSPOST_FN = FN_URL('auspost-rates')

function Section({ title, hint, children }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: C.muted, marginTop: 3, marginBottom: 14, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  )
}

const numInput = { ...{}, width: 70, padding: '7px 9px', borderRadius: 6, border: `1.5px solid #e6e2d8`, fontSize: 13, outline: 'none' }

export default function ShippingSettings({ storeId }) {
  const [defW, setDefW] = useState('')
  const [defDims, setDefDims] = useState({ l: '', w: '', h: '' })
  const [cats, setCats] = useState({}) // cat -> { weightG, l, w, h }
  const [allowOffers, setAllowOffers] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  // Australia Post live rates
  const [apFrom, setApFrom] = useState('')       // dispatch (from) postcode
  const [apTo, setApTo] = useState('3000')       // a destination to test against
  const [apStatus, setApStatus] = useState(null) // { configured, account } from the edge fn
  const [apTesting, setApTesting] = useState(false)
  const [apResult, setApResult] = useState(null) // { cost, service } | { error }

  const apHeaders = async () => {
    const { data: { session } } = await sb.auth.getSession()
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }
  }
  const checkApStatus = async () => {
    try {
      const res = await fetch(AUSPOST_FN, { method: 'POST', headers: await apHeaders(), body: JSON.stringify({ action: 'status', storeId }) })
      setApStatus(await res.json())
    } catch { setApStatus({ configured: false }) }
  }
  const testRate = async () => {
    setApTesting(true); setApResult(null)
    try {
      const res = await fetch(AUSPOST_FN, {
        method: 'POST', headers: await apHeaders(),
        body: JSON.stringify({
          action: 'calculate', storeId,
          fromPostcode: String(apFrom).trim(), toPostcode: String(apTo).trim(),
          weightKg: +defW > 0 ? +defW / 1000 : 0.5,
          length: +defDims.l || undefined, width: +defDims.w || undefined, height: +defDims.h || undefined,
        }),
      })
      const d = await res.json()
      setApResult(d.error ? { error: d.error } : { cost: d.cost, service: d.service })
    } catch (e) { setApResult({ error: e.message }) }
    setApTesting(false)
  }

  useEffect(() => {
    if (!storeId) return
    setLoading(true)
    sb.from('stores').select('settings').eq('id', storeId).single().then(({ data }) => {
      const s = data?.settings?.shipping || {}
      setDefW(s.defaultWeightG ?? '')
      setDefDims({ l: s.defaultDimsCm?.l ?? '', w: s.defaultDimsCm?.w ?? '', h: s.defaultDimsCm?.h ?? '' })
      setCats(s.categories || {})
      setAllowOffers(!!data?.settings?.allowOffers)
      setApFrom(data?.settings?.auspost?.fromPostcode ?? '')
      setLoading(false)
    })
    checkApStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId])

  const setCat = (cat, key, val) => setCats(c => ({ ...c, [cat]: { ...c[cat], [key]: val } }))

  const save = async () => {
    setSaving(true)
    try {
      // Strip empty category rows so we don't store noise
      const cleanCats = {}
      for (const [cat, v] of Object.entries(cats)) {
        const row = {}
        if (+v?.weightG > 0) row.weightG = +v.weightG
        if (+v?.l > 0) row.l = +v.l
        if (+v?.w > 0) row.w = +v.w
        if (+v?.h > 0) row.h = +v.h
        if (Object.keys(row).length) cleanCats[cat] = row
      }
      const shipping = {
        defaultWeightG: +defW > 0 ? +defW : undefined,
        defaultDimsCm: (+defDims.l > 0 || +defDims.w > 0 || +defDims.h > 0) ? { l: +defDims.l || undefined, w: +defDims.w || undefined, h: +defDims.h || undefined } : undefined,
        categories: cleanCats,
      }
      const { data: cur } = await sb.from('stores').select('settings').eq('id', storeId).single()
      const auspost = String(apFrom).trim() ? { ...(cur?.settings?.auspost || {}), fromPostcode: String(apFrom).trim() } : (cur?.settings?.auspost || undefined)
      await sb.from('stores').update({ settings: { ...(cur?.settings || {}), shipping, allowOffers, auspost } }).eq('id', storeId)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e) { alert(`Save failed: ${e.message}`) }
    setSaving(false)
  }

  if (loading) return <div style={{ color: C.muted, padding: 20 }}>Loading…</div>

  return (
    <>
      <Section title="Listing defaults" hint="Defaults applied to new eBay listings.">
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.text, cursor: 'pointer' }}>
          <input type="checkbox" checked={allowOffers} onChange={e => setAllowOffers(e.target.checked)} style={{ width: 18, height: 18 }} />
          Allow buyers to make offers (Best Offer)
        </label>
      </Section>

      <Section title="Default package" hint="Used for any part without its own weight or a category preset. Weight in grams, dimensions in cm. eBay uses these to calculate the buyer's shipping cost.">
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
            Weight (g) <input type="number" value={defW} onChange={e => setDefW(e.target.value)} placeholder="1000" style={numInput} />
          </label>
          <label style={{ fontSize: 13, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
            Box L×W×H (cm)
            <input type="number" value={defDims.l} onChange={e => setDefDims(d => ({ ...d, l: e.target.value }))} placeholder="30" style={numInput} />×
            <input type="number" value={defDims.w} onChange={e => setDefDims(d => ({ ...d, w: e.target.value }))} placeholder="20" style={numInput} />×
            <input type="number" value={defDims.h} onChange={e => setDefDims(d => ({ ...d, h: e.target.value }))} placeholder="15" style={numInput} />
          </label>
        </div>
      </Section>

      <Section title="Per-category presets" hint="Optional. Set a typical weight and box size per category, so each listing gets realistic shipping without weighing every part. A part's own weight (if set) always wins.">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', color: C.muted, fontSize: 11, fontWeight: 700 }}>Category</th>
                <th style={{ padding: '6px 8px', color: C.muted, fontSize: 11, fontWeight: 700 }}>Weight (g)</th>
                <th style={{ padding: '6px 8px', color: C.muted, fontSize: 11, fontWeight: 700 }}>L</th>
                <th style={{ padding: '6px 8px', color: C.muted, fontSize: 11, fontWeight: 700 }}>W</th>
                <th style={{ padding: '6px 8px', color: C.muted, fontSize: 11, fontWeight: 700 }}>H</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORY_NAMES.map(cat => (
                <tr key={cat} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '6px 8px', color: C.text }}>{cat}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}><input type="number" value={cats[cat]?.weightG ?? ''} onChange={e => setCat(cat, 'weightG', e.target.value)} placeholder="—" style={{ ...numInput, width: 80 }} /></td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}><input type="number" value={cats[cat]?.l ?? ''} onChange={e => setCat(cat, 'l', e.target.value)} placeholder="—" style={{ ...numInput, width: 56 }} /></td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}><input type="number" value={cats[cat]?.w ?? ''} onChange={e => setCat(cat, 'w', e.target.value)} placeholder="—" style={{ ...numInput, width: 56 }} /></td>
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}><input type="number" value={cats[cat]?.h ?? ''} onChange={e => setCat(cat, 'h', e.target.value)} placeholder="—" style={{ ...numInput, width: 56 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="🇦🇺 Australia Post live rates" hint="Cost postage from real Australia Post parcel prices instead of weight estimates. Add the AUSPOST_API_KEY secret in Supabase (a free key from developers.auspost.com.au), set your dispatch postcode below, then Test. Account-negotiated rates can be added once your Aus Post account details are connected.">
        <div style={{ fontSize: 12.5, marginBottom: 12, fontWeight: 600, color: apStatus?.configured ? C.green : C.muted }}>
          {apStatus == null ? 'Checking connection…'
            : apStatus.configured ? `✓ Connected — ${apStatus.account ? 'account rates available' : 'retail rates'}`
            : '○ Not connected. Add the AUSPOST_API_KEY secret in Supabase to enable live rates.'}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 13, color: C.text, display: 'flex', flexDirection: 'column', gap: 4 }}>
            Dispatch postcode (from)
            <input value={apFrom} onChange={e => setApFrom(e.target.value)} placeholder="e.g. 4000" style={{ ...numInput, width: 110 }} />
          </label>
          <label style={{ fontSize: 13, color: C.text, display: 'flex', flexDirection: 'column', gap: 4 }}>
            Test destination (to)
            <input value={apTo} onChange={e => setApTo(e.target.value)} placeholder="3000" style={{ ...numInput, width: 110 }} />
          </label>
          <button onClick={testRate} disabled={apTesting || !apStatus?.configured || !String(apFrom).trim()}
            style={{ ...S.btn('secondary'), padding: '9px 16px', fontSize: 13, opacity: (apTesting || !apStatus?.configured || !String(apFrom).trim()) ? 0.55 : 1 }}>
            {apTesting ? 'Checking…' : 'Test rate'}
          </button>
        </div>
        {apResult && (
          <div style={{ marginTop: 12, fontSize: 13, color: apResult.error ? C.red : C.green, fontWeight: 600 }}>
            {apResult.error
              ? `✗ ${apResult.error}`
              : `≈ $${Number(apResult.cost).toFixed(2)} — ${apResult.service || 'Parcel Post'} (for a ${+defW > 0 ? defW : 500}g default parcel ${apFrom} → ${apTo})`}
          </div>
        )}
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10, lineHeight: 1.5 }}>
          Once connected, the Dashboard's postage cost switches from an estimate to real Australia Post prices. Remember to <strong>Save</strong> after changing the dispatch postcode.
        </div>
      </Section>

      <button onClick={save} disabled={saving} style={{ ...S.btn(saved ? 'success' : 'primary'), padding: '11px 26px' }}>
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save shipping settings'}
      </button>
    </>
  )
}
