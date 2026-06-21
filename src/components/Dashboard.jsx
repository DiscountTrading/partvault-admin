import { C, S, fmt, pct, totalCost, postageCostFor, partEffectiveCost, bucketByAge, DEFAULT_AGED_THRESHOLD_DAYS, DEFAULT_AGE_BRACKETS, CATEGORY_NAMES } from '../lib/constants'

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ ...S.card, borderTop:`3px solid ${color||C.accent}` }}>
      <div style={S.statLbl}>{label}</div>
      <div style={{ ...S.statVal, color:color||C.accent }}>{value}</div>
      {sub && <div style={{ fontSize:13, color:C.muted, marginTop:2 }}>{sub}</div>}
    </div>
  )
}

export default function Dashboard({ parts, costing, inventory }) {
  const active = parts.filter(p=>!p.deletedAt)
  const inStock = active.filter(p=>p.status==='in_stock')
  const listed = active.filter(p=>p.status==='listed')
  const sold = active.filter(p=>p.status==='sold')
  // Revenue includes the shipping the buyer paid (income), not just the item price.
  const soldRev = sold.reduce((a,p)=>a+(+p.soldPrice||+p.list_price||0)+(+p.shippingCharged||0),0)
  // COGS uses recorded costs where present, else a full estimate (base cost +
  // postage + admin + labour) so parts with no cost history still show a margin.
  let cogsEstimated = false
  const soldCogs = sold.reduce((a,p)=>{
    const c = partEffectiveCost(p, costing||{}); if (c.estimated) cogsEstimated = true; return a + c.value
  },0)
  const gross = soldRev - soldCogs
  const margin = soldRev>0?(gross/soldRev)*100:0
  // Shipping: income the buyer paid vs the postage cost we paid the carrier.
  // Cost uses the recorded carrier cost where present, else a weight-based
  // estimate (so free-shipping sales don't show a $0 postage cost).
  const shipInc = sold.reduce((a,p)=>a+(+p.shippingCharged||0),0)
  let shipCostEstimated = false
  const shipCost = sold.reduce((a,p)=>{
    const c = postageCostFor(p, costing||{})
    if (c.estimated && c.value>0) shipCostEstimated = true
    return a + c.value
  },0)
  const netShip = shipInc - shipCost
  const stockVal = [...inStock,...listed].reduce((a,p)=>a+partEffectiveCost(p, costing||{}).value,0)

  const catBreak = CATEGORY_NAMES.map(cat=>({ cat, count:active.filter(p=>p.category===cat).length }))
    .filter(x=>x.count>0).sort((a,b)=>b.count-a.count).slice(0,8)

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
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, paddingBottom:16, borderBottom:`1px solid ${C.border}` }}>
        <h2 style={{ ...S.h1 }}>📊 Dashboard</h2>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:20, marginBottom:20 }}>
        <StatCard label="Total Parts" value={active.length} sub={`${inStock.length} in stock`} />
        <StatCard label="Listed on eBay" value={listed.length} color={C.accent} />
        <StatCard label="Total Sold" value={sold.length} color={C.blue} sub="orders" />
        <StatCard label="Total Sales" value={fmt(soldRev)} color={C.green} sub="item + shipping (matches eBay)" />
        <StatCard label="Gross Profit" value={fmt(gross)} color={margin>30?C.green:C.yellow} sub={pct(margin)+' margin'+(cogsEstimated?' · incl. est. cost':'')} />
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:20 }}>
        <div style={S.card}>
          <h2 style={S.h2}>Stock by Category</h2>
          {catBreak.map(({cat,count})=>(
            <div key={cat} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:`1px solid ${C.border}`, fontSize:14 }}>
              <span>{cat}</span>
              <span style={{ color:C.accent, fontWeight:700 }}>{count}</span>
            </div>
          ))}
          {!catBreak.length && <p style={{ color:C.muted, fontSize:12 }}>No parts yet.</p>}
        </div>
        <div style={S.card}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:14 }}>
            <h2 style={{ ...S.h2, margin:0 }}>Aged Stock</h2>
            <span style={{ fontSize:12, color:C.muted }}>{aged.length.toLocaleString()} items &gt;{agedThreshold}d · {fmt(agedValue)} listed</span>
          </div>
          {!aged.length && <p style={{ color:C.muted, fontSize:12 }}>No stock aged over {agedThreshold} days.</p>}
          {aged.length>0 && ageBuckets.map((b,i)=>{
            // Older brackets shade from yellow → red so the tail stands out.
            const t = ageBuckets.length>1 ? i/(ageBuckets.length-1) : 0
            const col = t<0.34?C.yellow:t<0.67?'#d9480f':C.red
            return (
              <div key={b.label} style={{ marginBottom:8 }}>
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
          <div style={{ marginTop:14, borderTop:`1px solid ${C.border}`, paddingTop:12, display:'flex', gap:24, flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>INVENTORY VALUE (at cost)</div>
              <div style={{ fontSize:22, fontWeight:700, color:C.blue }}>{fmt(stockVal)}</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>SHIPPING INCOME</div>
              <div style={{ fontSize:22, fontWeight:700, color:C.green }}>{fmt(shipInc)}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>buyer-paid (from eBay)</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>SHIPPING COST</div>
              <div style={{ fontSize:22, fontWeight:700, color:C.yellow }}>{fmt(shipCost)}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{shipCostEstimated ? 'postage paid (incl. est.)' : 'postage paid'}</div>
            </div>
            <div>
              <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>NET SHIPPING</div>
              <div style={{ fontSize:22, fontWeight:700, color: netShip>=0?C.green:C.red }}>{fmt(netShip)}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>income − cost</div>
            </div>
          </div>
        </div>
      </div>
      <div style={S.card}>
        <h2 style={S.h2}>P&L Summary</h2>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:20 }}>
          {[['Total Revenue',fmt(soldRev),C.white],['Total COGS',fmt(soldCogs),C.red],['Gross Profit',fmt(gross),C.green],['Gross Margin',pct(margin),margin>30?C.green:C.yellow]].map(([l,v,col])=>(
            <div key={l}>
              <div style={{ ...S.statLbl, marginBottom:4 }}>{l}</div>
              <div style={{ fontSize:22, fontWeight:700, color:col }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
