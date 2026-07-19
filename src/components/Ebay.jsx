import { C, S } from '../lib/constants'
import SkuReconcile from './SkuReconcile'

// Listing + de-listing now live in Inventory (the 🛒 eBay toggle → select parts →
// List / De-list in bulk, plus 👁 to preview). This tab keeps only the eBay tools
// that aren't a per-part inventory action.
export default function Ebay({ storeId, onChanged, parts = [] }) {
  return (
    <div>
      <h2 style={{ ...S.h1, marginBottom: 10 }}>eBay</h2>
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 16px', marginBottom: 18, fontSize: 13, color: '#1d4ed8', lineHeight: 1.6 }}>
        📦 <strong>Listing &amp; de-listing moved to Inventory.</strong> Open <strong>Inventory</strong>, click the <strong>🛒 eBay</strong> toggle, then <strong>List</strong> (in-stock parts) or <strong>De-list</strong> (live parts) — select rows and act in bulk, or hit <strong>👁</strong> on any part to preview its exact eBay listing first.
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 10 }}>🔄 SKU reconcile</div>
      <SkuReconcile storeId={storeId} parts={parts} onApplied={onChanged} />
    </div>
  )
}
