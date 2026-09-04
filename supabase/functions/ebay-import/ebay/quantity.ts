// ═══════════════════════════════════════════════════════════════════════════
//  Multi-quantity stock lines — the decisions, isolated so they can be tested.
//
//  A part row is a STOCK LINE: `quantity` units acquired, `quantity_sold`
//  units gone, available = the difference. A dismantled part is unique, so
//  both stay 1/0 and every rule here must collapse to the old behaviour:
//  one sale closes the line. That equivalence is what makes this safe to
//  ship against a live store where every part is quantity 1.
//
//  The rule that keeps the counts correct: units sold is DERIVED, never
//  incremented. The sales sync re-reads the same order windows every run, so
//  `quantity_sold += qty` would count each sale once per sync forever. Instead
//  every settle recomputes from independent tallies (the ebay_sales rows for
//  the part; eBay's own lifetime QuantitySold for the listing; the row's
//  current value) and takes the max — re-running any path is a no-op.
// ═══════════════════════════════════════════════════════════════════════════

export interface SettleInput {
  quantity: number | null | undefined       // units acquired (row value)
  quantitySold: number | null | undefined   // row value before this settle
  derivedUnits: number                      // Σ ebay_sales.quantity for this part (non-cancelled)
  ebayQuantitySold?: number                 // eBay's lifetime QuantitySold for the listing, when known
  endedOnEbay?: boolean                     // the listing is finished — unsold units return to stock
}

export interface SettleDecision {
  single: boolean          // quantity ≤ 1 → caller performs the exact legacy whole-line write
  soldUnits: number        // what quantity_sold should now be (multi-unit lines only)
  closed: boolean          // nothing left → the line closes (part and listing go 'sold')
  status: string | null    // part status to write, or null to leave it untouched
}

export function settleDecision(i: SettleInput): SettleDecision {
  const qty = Math.floor(Number(i.quantity) || 1)
  if (qty <= 1) return { single: true, soldUnits: 1, closed: true, status: 'sold' }
  const soldUnits = Math.max(
    0,
    Math.floor(Number(i.derivedUnits) || 0),
    Math.floor(Number(i.quantitySold) || 0),
    Math.floor(Number(i.ebayQuantitySold) || 0),
  )
  const closed = soldUnits >= qty
  // Open line: status stays as it is (still listed, still selling) — unless the
  // listing itself is over on eBay, in which case the remaining units are back
  // on the shelf and the line returns to stock.
  const status = closed ? 'sold' : (i.endedOnEbay ? 'in_stock' : null)
  return { single: false, soldUnits, closed, status }
}

// On a multi-unit line, the part row's sold_price means "price per unit,
// latest sale" — line totals live in ebay_sales, and unit price is the only
// figure that stays comparable as the line sells down. A single-unit line's
// sale IS one unit, so this returns the price unchanged there.
export function perUnitPrice(lineTotal: number | null | undefined, unitsInSale: number | null | undefined): number | null {
  const t = Number(lineTotal) || 0
  if (t <= 0) return null
  const u = Math.max(1, Math.floor(Number(unitsInSale) || 1))
  return Math.round((t / u) * 100) / 100
}

// What eBay is told is available to ship when a line is published. Floored at
// 1: this is only called for a line being (re)listed, and eBay rejects a
// zero-quantity offer outright — a fully-sold line should not reach publish.
export function availableQuantity(part: { quantity?: number | null; quantity_sold?: number | null }): number {
  const q = Math.max(1, Math.floor(Number(part?.quantity) || 1))
  const s = Math.max(0, Math.floor(Number(part?.quantity_sold) || 0))
  return Math.max(1, q - s)
}
