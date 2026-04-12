import { C, S, fmt, pct, totalCost, CATEGORY_NAMES } from '../lib/constants'

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ ...S.card, borderTop:`3px solid ${color||C.accent}` }}>
      <div style={S.statLbl}>{label}</div>
      <div style={{ ...S.statVal, color:color||C.accent }}>{value}</div>
      {sub && <div style={{ fontSize:13, color:C.muted, marginTop:2 }}>{sub}</div>}
    </div>
  )
}

export default function Dashboard({ parts }) {
  const active = parts.filter(p=>p.status!=='Deleted')
  const inStock = active.filter(p=>p.status==='In Stock')
  const listed = active.filter(p=>p.status==='Listed')
  const sold = active.filter(p=>p.status==='Sold')
  const soldRev = sold.reduce((a,p)=>a+(+p.soldPrice||+p.list_price||0),0)
  const soldCogs = sold.reduce((a,p)=>a+totalCost(p),0)
  const gross = soldRev - soldCogs
  const margin = soldRev>0?(gross/soldRev)*100:0
  const stockVal = [...inStock,...listed].reduce((a,p)=>a+totalCost(p),0)

  const catBreak = CATEGORY_NAMES.map(cat=>({ cat, count:active.filter(p=>p.category===cat).length }))
    .filter(x=>x.count>0).sort((a,b)=>b.count-a.count).slice(0,8)

  const aged = listed.filter(p=>{
    if (!p.listedDate) return false
    return Math.floor((Date.now()-new Date(p.listedDate))/86400000)>60
  })

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, paddingBottom:16, borderBottom:`1px solid ${C.border}` }}>
        <h2 style={{ ...S.h1 }}>📊 Dashboard</h2>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:20, marginBottom:20 }}>
        <StatCard label="Total Parts" value={active.length} sub={`${inStock.length} in stock`} />
        <StatCard label="Listed on eBay" value={listed.length} color={C.accent} />
        <StatCard label="Total Sold" value={sold.length} color={C.green} sub={fmt(soldRev)+' revenue'} />
        <StatCard label="Gross Profit" value={fmt(gross)} color={margin>30?C.green:C.yellow} sub={pct(margin)+' margin'} />
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
          <h2 style={S.h2}>Aged Stock & Alerts</h2>
          {!aged.length && <p style={{ color:C.muted, fontSize:12 }}>No aged stock alerts.</p>}
          {aged.slice(0,6).map(p=>{
            const days = Math.floor((Date.now()-new Date(p.listedDate))/86400000)
            return (
              <div key={p.id} style={{ padding:'6px 0', borderBottom:`1px solid ${C.border}` }}>
                <div style={{ fontSize:14, color:days>90?C.red:C.yellow, fontWeight:500 }}>{p.title}</div>
                <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>Listed {days} days · {fmt(p.listPrice)}</div>
              </div>
            )
          })}
          <div style={{ marginTop:14, borderTop:`1px solid ${C.border}`, paddingTop:12 }}>
            <div style={{ fontSize:10, color:C.muted, marginBottom:4 }}>INVENTORY VALUE (at cost)</div>
            <div style={{ fontSize:22, fontWeight:700, color:C.blue }}>{fmt(stockVal)}</div>
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
