import { useState } from 'react'
import { C, S, fmt, pct, totalCost, postageCostFor, estimatePostage, partEffectiveCost, bucketByAge, DEFAULT_AGED_THRESHOLD_DAYS, DEFAULT_AGE_BRACKETS, CATEGORY_NAMES } from '../lib/constants'

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ ...S.card, borderTop:`3px solid ${color||C.accent}` }}>
      <div style={S.statLbl}>{label}</div>
      <div style={{ ...S.statVal, color:color||C.accent }}>{value}</div>
      {sub && <div style={{ fontSize:13, color:C.muted, marginTop:2 }}>{sub}</div>}
    </div>
  )
}

export default function Dashboard({ parts, sales = [], costing, inventory, onDrill, onSeeSales }) {
  // Sales/P&L are shown for a selectable window (eBay reports last 90 days, so
  // 90 is the default for a like-for-like comparison). 0 = all time.
  const [periodDays, setPeriodDays] = useState(90)
  const PERIODS = [[30,'30d'],[90,'90d'],[365,'12mo'],[0,'All']]
  // Imported historical sales carry a snapshotted (estimated) cost rather than real
  // fees/COGS. Toggle them in/out so you can compare lifetime figures vs pure
  // API-real data. `isHist` flags a row whose costs come from the locked snapshot.
  const [includeHistory, setIncludeHistory] = useState(true)
  const isHist = s => s.source === 'csv_orders_report'

  const active = parts.filter(p=>!p.deletedAt)
  const inStock = active.filter(p=>p.status==='in_stock')
  const listed = active.filter(p=>p.status==='listed')
  // Map parts by id so each sale can pull its linked part's cost (for COGS).
  const partById = new Map(active.map(p=>[p.id,p]))

  // SALES come from the ebay_sales mirror (one row per eBay order line item), so
  // revenue + fees equal eBay's report exactly. Restrict to the selected window.
  const inPeriod = s => !periodDays || (s.soldAt && (Date.now()-new Date(s.soldAt)) <= periodDays*86400000)
  const sold = sales.filter(inPeriod).filter(s => includeHistory || !isHist(s))
  const periodLabel = periodDays ? `last ${periodDays===365?'12 months':periodDays+' days'}` : 'all time'
  // Revenue includes the shipping the buyer paid (income), net of any refund
  // returned to the buyer (a ship-then-refund nets toward $0 revenue).
  const soldRev = sold.reduce((a,s)=>a+(+s.soldPrice||0)+(+s.shipping||0)-(+s.refund||0),0)
  const refundTotal = sold.reduce((a,s)=>a+(+s.refund||0),0)
  // COGS: use the linked inventory part's effective cost where we have one; sales
  // with no matching part contribute 0 cost (item was never in our inventory).
  let cogsEstimated = false
  const soldCogs = sold.reduce((a,s)=>{
    // Imported history: use the locked snapshot (purchase + admin + labour + storage).
    if (isHist(s) && s.costs) { cogsEstimated = true; return a + (+s.costs.purchase||0)+(+s.costs.admin||0)+(+s.costs.labour||0)+(+s.costs.storage||0) }
    const p = s.partId && partById.get(s.partId)
    if (!p) return a
    const c = partEffectiveCost(p, costing||{}); if (c.estimated) cogsEstimated = true; return a + c.value
  },0)
  const gross = soldRev - soldCogs
  const margin = soldRev>0?(gross/soldRev)*100:0
  // eBay selling fees (from Finances API, stored per sale row) and net sales after
  // them — mirrors eBay's report: Total sales − Selling costs = Net sales.
  const ebayFees = sold.reduce((a,s)=>{
    if ((+s.fees||0) > 0) return a + (+s.fees)                                       // real (incl. Finances backfill)
    if (isHist(s) && s.costs) return a + (+s.costs.ebay_listing||0)+(+s.costs.promotion||0) // modelled fallback
    return a
  },0)
  const netSales = soldRev - ebayFees
  // Shipping: income the buyer paid vs the postage cost we paid the carrier.
  // Cost uses the linked part's recorded carrier cost / weight estimate.
  const shipInc = sold.reduce((a,s)=>a+(+s.shipping||0),0)
  // Cost we actually paid the carrier: prefer the real eBay shipping-label cost
  // (captured from the Finances API, also incurred on ship-then-refund orders),
  // else fall back to the linked part's recorded/estimated postage.
  let shipCostEstimated = false
  const shipCost = sold.reduce((a,s)=>{
    if ((+s.shipCost||0) > 0) return a + (+s.shipCost)        // real eBay label cost (incl. backfill)
    if (isHist(s) && s.costs) return a + (+s.costs.postage||0) // imported history snapshot fallback
    const p = s.partId && partById.get(s.partId)
    if (p) {                                                  // linked part → its cost/estimate
      const c = postageCostFor(p, costing||{})
      if (c.estimated && c.value>0) shipCostEstimated = true
      return a + c.value
    }
    // No eBay label AND no linked part → store's default-weight postage estimate
    // (uses the configurable tiers + default weight + handling from Settings),
    // so off-eBay shipping on unmatched sales is still costed, not $0.
    const est = estimatePostage({}, costing||{}).total
    if (est > 0) shipCostEstimated = true
    return a + est
  },0)
  const netShip = shipInc - shipCost
  const stockVal = [...inStock,...listed].reduce((a,p)=>a+partEffectiveCost(p, costing||{}).value,0)

  const catBreak = CATEGORY_NAMES.map(cat=>({ cat, count:active.filter(p=>p.category===cat).length }))
    .filter(x=>x.count>0).sort((a,b)=>b.count-a.count).slice(0,6)

  // Age of a still-unsold part. The eBay sync doesn't set listed_date, so fall
  // back to acquired_date (the listing's start) then created_at, else nothing.
  const ageDays = p => {
    const d = p.listedDate || p.acquiredDate || p.createdAt
    if (!d) return null
    const days = Math.floor((Date.now() - new Date(d)) / 86400000)
    return Number.isFinite(days) ? days : null
  }
  const agedThreshold = +inventory?.agedThresholdDays || DEFAULT_AGED_THRESHOLD_DAYS
  const brackets = (inventory?.ageBrackets?.length ? inventory.ageBrackets : DEFAULT_AGE_BRACKETS)
  const aged = listed.filter(p => { const d = ageDays(p); return d != null && d > agedThreshold })
  // Bucket aged stock into the configured day brackets; value = retail (list price) tied up.
  const ageBuckets = bucketByAge(aged, brackets, ageDays, p => +p.listPrice || +p.list_price || 0)
  const maxBucket = Math.max(1, ...ageBuckets.map(b => b.count))
  const agedValue = aged.reduce((a,p) => a + (+p.listPrice || +p.list_price || 0), 0)

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, paddingBottom:10, borderBottom:`1px solid ${C.border}` }}>
        <h2 style={{ ...S.h1 }}>📊 Dashboard</h2>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <label style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, color:C.muted, cursor:'pointer' }} title="Imported historical sales use estimated (snapshot) costs.">
            <input type="checkbox" checked={includeHistory} onChange={e=>setIncludeHistory(e.target.checked)} />
            Include imported history
          </label>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:12, color:C.muted }}>Sales period:</span>
            <div style={{ display:'inline-flex', border:`1px solid ${C.border}`, borderRadius:8, overflow:'hidden' }}>
              {PERIODS.map(([d,lbl])=>(
                <button key={d} type="button" onClick={()=>setPeriodDays(d)}
                  style={{ padding:'5px 12px', fontSize:12, fontWeight:600, border:'none', cursor:'pointer', background: periodDays===d?C.accent:'#fff', color: periodDays===d?'#fff':C.muted }}>{lbl}</button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:14, marginBottom:12 }}>
        <StatCard label="Total Parts" value={active.length} sub={`${inStock.length} in stock`} />
        <StatCard label="Listed on eBay" value={listed.length} color={C.accent} />
        <StatCard label="Sold" value={sold.length} color={C.blue} sub={periodLabel} />
        <StatCard label="Sales" value={fmt(soldRev)} color={C.green} sub={`item + shipping · ${periodLabel}`} />
        <StatCard label="Gross Profit" value={fmt(gross)} color={margin>30?C.green:C.yellow} sub={pct(margin)+' margin'+(cogsEstimated?' · incl. est. cost':'')} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:12 }}>
        <div style={{ ...S.card, padding:18 }}>
          <h2 style={{ ...S.h2, marginBottom:10 }}>Stock by Category</h2>
          {catBreak.map(({cat,count})=>{
            const drill = () => onDrill?.({ partIds: active.filter(p=>p.category===cat).map(p=>p.id), label:cat })
            return (
              <div key={cat} onClick={drill} title={`View ${count} ${cat} parts in Insights`}
                style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:`1px solid ${C.border}`, fontSize:13, cursor:'pointer' }}>
                <span>{cat}</span>
                <span style={{ color:C.accent, fontWeight:700 }}>{count}</span>
              </div>
            )
          })}
          {!catBreak.length && <p style={{ color:C.muted, fontSize:12 }}>No parts yet.</p>}
          {!!catBreak.length && <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>Click a category to see those parts in Insights.</div>}
        </div>
        <div style={{ ...S.card, padding:18 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:14 }}>
            <h2 style={{ ...S.h2, margin:0 }}>Aged Stock</h2>
            <span style={{ fontSize:12, color:C.muted }}>{aged.length.toLocaleString()} items &gt;{agedThreshold}d · {fmt(agedValue)} listed</span>
          </div>
          {!aged.length && <p style={{ color:C.muted, fontSize:12 }}>No stock aged over {agedThreshold} days.</p>}
          {aged.length>0 && ageBuckets.map((b,i)=>{
            // Older brackets shade from yellow → red so the tail stands out.
            const t = ageBuckets.length>1 ? i/(ageBuckets.length-1) : 0
            const col = t<0.34?C.yellow:t<0.67?'#d9480f':C.red
            const drill = () => {
              const ids = aged.filter(p=>{ const d=ageDays(p); return d!=null && (b.max==null ? d>=b.min : (d>=b.min && d<b.max)) }).map(p=>p.id)
              onDrill?.({ partIds:ids, label:`Aged ${b.label}`, sort:{ key:'days_on_shelf', dir:'desc' } })
            }
            return (
              <div key={b.label} onClick={b.count?drill:undefined} title={b.count?`View ${b.count} items in ${b.label} in Insights`:undefined}
                style={{ marginBottom:6, cursor:b.count?'pointer':'default' }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                  <span style={{ color:C.text }}>{b.label}</span>
                  <span style={{ color:C.muted }}><strong style={{ color:C.text }}>{b.count.toLocaleString()}</strong> · {fmt(b.value)}</span>
                </div>
                <div style={{ height:10, background:C.bg, borderRadius:5, overflow:'hidden' }}>
                  <div style={{ width:`${(b.count/maxBucket)*100}%`, height:'100%', background:col, borderRadius:5, minWidth:b.count?4:0 }} />
                </div>
              </div>
            )
          })}
          {aged.length>0 && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>Click a band to see those parts in Insights.</div>}
          <div style={{ marginTop:10, borderTop:`1px solid ${C.border}`, paddingTop:10, display:'flex', gap:20, flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:2 }}>INVENTORY VALUE (at cost)</div>
              <div style={{ fontSize:18, fontWeight:700, color:C.blue }}>{fmt(stockVal)}</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:2 }}>SHIPPING INCOME</div>
              <div style={{ fontSize:18, fontWeight:700, color:C.green }}>{fmt(shipInc)}</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:2 }}>SHIPPING COST</div>
              <div style={{ fontSize:18, fontWeight:700, color:C.yellow }}>{fmt(shipCost)}</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:2 }}>NET SHIPPING</div>
              <div style={{ fontSize:18, fontWeight:700, color: netShip>=0?C.green:C.red }}>{fmt(netShip)}</div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ ...S.card, padding:18 }}>
        <h2 style={{ ...S.h2, marginBottom:10 }}>P&L Summary <span style={{ fontWeight:400, fontSize:12, color:C.muted }}>· {periodLabel}{cogsEstimated?' · cost incl. estimates':''}</span></h2>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:20, rowGap:14 }}>
          {[
            ['Total Sales',fmt(soldRev),C.text],
            ['Refunds (netted)',refundTotal>0?('−'+fmt(refundTotal)):fmt(0),refundTotal>0?C.red:C.muted],
            ['eBay Fees',ebayFees>0?('−'+fmt(ebayFees)):fmt(0),ebayFees>0?C.red:C.muted],
            ['Net Sales (after fees)',fmt(netSales),C.text],
            ['Total COGS',soldCogs>0?fmt(soldCogs):fmt(0),soldCogs>0?C.red:C.muted],
            ['Gross Profit',fmt(gross),C.green],
            ['Gross Margin',pct(margin),margin>30?C.green:C.yellow],
          ].map(([l,v,col])=>(
            <div key={l}>
              <div style={{ ...S.statLbl, marginBottom:4 }}>{l}</div>
              <div style={{ fontSize:22, fontWeight:700, color:col }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize:11, color:C.muted, marginTop:8 }}>Total Sales − eBay Fees = Net Sales (matches eBay's report). Gross Profit also subtracts part cost, postage & admin.</div>
      </div>

      {/* Recent sales — last few, click through to the full Sales tab */}
      <div style={{ ...S.card, padding:18, marginTop:18 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <h2 style={{ ...S.h2, margin:0 }}>Recent Sales</h2>
          <button onClick={onSeeSales} style={{ background:'none', border:'none', color:C.accent, cursor:'pointer', fontSize:13, fontWeight:600 }}>View all sales →</button>
        </div>
        {(() => {
          const recent = [...sales].filter(s=>!s.cancelled && s.soldAt).sort((a,b)=>new Date(b.soldAt)-new Date(a.soldAt)).slice(0,8)
          if (recent.length === 0) return <div style={{ fontSize:13, color:C.muted, padding:'8px 0' }}>No sales recorded yet.</div>
          const net = s => (+s.soldPrice||0)+(+s.shipping||0)-(+s.refund||0)-(+s.fees||0)
          return (
            <div style={{ display:'flex', flexDirection:'column' }}>
              {recent.map(s => (
                <div key={s.id} onClick={onSeeSales} style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 0', borderBottom:`1px solid ${C.border}`, cursor:'pointer' }}>
                  <span style={{ fontSize:12, color:C.muted, flexShrink:0, width:64 }}>{s.soldAt ? new Date(s.soldAt).toLocaleDateString('en-AU',{day:'numeric',month:'short'}) : '—'}</span>
                  <span style={{ flex:1, minWidth:0, fontSize:13, color:C.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={s.title}>{s.title || s.sku || 'eBay sale'}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:C.green, flexShrink:0 }}>{fmt(net(s))}</span>
                </div>
              ))}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
