import { useState } from 'react'
import { C, S } from '../lib/constants'
import Publish from './Publish'
import Delist from './Delist'
import SkuReconcile from './SkuReconcile'

const SUBS = [
  { id: 'list', label: 'List' },
  { id: 'delist', label: 'De-list' },
  { id: 'skus', label: 'SKUs' },
]

export default function Ebay({ storeId, onChanged, parts = [] }) {
  const [sub, setSub] = useState('list')
  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 10 }}>eBay</h2>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
        {SUBS.map(t => (
          <button key={t.id} onClick={() => setSub(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 18px', fontSize: 14, fontWeight: sub === t.id ? 700 : 500,
            color: sub === t.id ? C.accent : C.muted,
            borderBottom: sub === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>
      {sub === 'list' && <Publish storeId={storeId} onChanged={onChanged} />}
      {sub === 'delist' && <Delist storeId={storeId} onChanged={onChanged} />}
      {sub === 'skus' && <SkuReconcile storeId={storeId} parts={parts} />}
    </div>
  )
}
