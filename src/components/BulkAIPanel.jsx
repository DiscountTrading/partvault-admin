import { useState, useMemo, useRef, useEffect } from 'react'
import { C, S, fmt, pct, totalCost, partEffectiveCost, estimateCostBasis, CATEGORY_NAMES, EBAY_AU_CATEGORIES, canonicalCategory, canonicalSubcategory, PART_CONDITIONS, STATUS_COLORS, STATUS_LABELS } from '../lib/constants'
import { sb } from '../lib/supabase'
import { getActiveMarketplace, formatWeight } from '../lib/marketplaces'
import { makesFor, MODEL_SUGS } from '../lib/vehicles'
import { printLabels, DEFAULT_LABELS } from '../lib/labels'
import { WAREHOUSE_DEFAULTS, warehouseConfig } from '../lib/warehouse'
import BulkEdit from './BulkEdit'
import ListingPreview from './ListingPreview'
import EbayActions from './EbayActions'
import useFillHeight from '../hooks/useFillHeight'

import { urlFrom, descPromptCore, generateAIDescription } from './inventoryShared'

// Bulk AI description generation for a group of parts — extracted verbatim
// from Inventory.jsx (refactor 3/5).
function BulkAIPanel({ group, onComplete, aiSettings, footer, storeId }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done:0, total:0, current:'' })
  const [done, setDone] = useState(false)
  const needsAI = group.parts.filter(p => !p.ai_assessed)

  const runBulk = async () => {
    setRunning(true); setDone(false)
    setProgress({ done:0, total:needsAI.length, current:'' })
    for (let i = 0; i < needsAI.length; i++) {
      const part = needsAI[i]
      setProgress({ done:i, total:needsAI.length, current:part.title||'Part' })
      try {
        const desc = await generateAIDescription(part, aiSettings, footer, storeId)
        await sb.from('parts').update({ description:desc, ai_assessed:true }).eq('id', part.id)
      } catch(e) { console.error('Failed for part', part.id, e) }
      await new Promise(r => setTimeout(r, 500))
    }
    setProgress(p => ({ ...p, done:needsAI.length, current:'' }))
    setRunning(false); setDone(true); onComplete()
  }

  return (
    <div style={{ background:'#eff6ff', border:`1px solid #bfdbfe`, borderRadius:10, padding:16, marginBottom:12 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:14, color:C.blue }}>✨ AI Descriptions — {group.make} {group.model} {group.year}</div>
          <div style={{ fontSize:12, color:C.muted, marginTop:3 }}>{needsAI.length} part{needsAI.length!==1?'s':''} without AI · {group.parts.length-needsAI.length} done</div>
        </div>
        <button style={{ ...S.btn('blue'), padding:'6px 14px', fontSize:12, opacity:running||needsAI.length===0?0.5:1 }} disabled={running||needsAI.length===0} onClick={runBulk}>
          {running ? `⏳ ${progress.done}/${progress.total}` : `✨ Generate All (${needsAI.length})`}
        </button>
      </div>
      {running && (
        <div style={{ marginTop:12 }}>
          <div style={{ height:6, background:'#dbeafe', borderRadius:3, overflow:'hidden' }}>
            <div style={{ height:'100%', background:C.blue, borderRadius:3, width:`${(progress.done/progress.total)*100}%`, transition:'width .3s' }} />
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>Processing: {progress.current}</div>
        </div>
      )}
      {done && <div style={{ fontSize:12, color:C.green, marginTop:8, fontWeight:600 }}>✓ All descriptions generated</div>}
    </div>
  )
}

// ─── Main Inventory ────────────────────────────────────────────────────────

export default BulkAIPanel
