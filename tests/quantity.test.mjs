// ═══════════════════════════════════════════════════════════════════════════
//  Multi-quantity stock lines — the settle decision every sale path shares.
//
//  The two properties that make this safe to run against a live store:
//
//  1. A quantity-1 part (every current Discount Trading part) takes the
//     `single` branch, whose caller performs the EXACT legacy whole-line
//     write. Any input that wobbles a qty-1 part off that branch is a bug.
//
//  2. Units sold is DERIVED, never incremented. The sales sync re-reads the
//     same order windows every run, so the decision must be idempotent:
//     feeding it its own output must change nothing.
//
//  Run: node --experimental-strip-types tests/quantity.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { settleDecision, perUnitPrice, availableQuantity } from '../supabase/functions/ebay-import/ebay/quantity.ts'

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

console.log('\nsettleDecision — a quantity-1 part is the legacy path, always\n')
{
  for (const [label, quantity] of [['1', 1], ['0', 0], ['null', null], ['undefined', undefined], ['NaN-ish string', 'x'], ['negative', -3]]) {
    const d = settleDecision({ quantity, quantitySold: 0, derivedUnits: 5 })
    ok(`quantity ${label} takes the single-unit branch`, d.single && d.closed && d.status === 'sold',
      JSON.stringify(d))
  }
  // Even sale-table noise (derivedUnits from a mislinked row) cannot pull a
  // single part off the legacy write — the caller never reads soldUnits there.
  eq('a fractional quantity floors before deciding', settleDecision({ quantity: 1.9, quantitySold: 0, derivedUnits: 0 }).single, true)
}

console.log('\nsettleDecision — a multi-unit line sells DOWN\n')
{
  const d = settleDecision({ quantity: 10, quantitySold: 0, derivedUnits: 4 })
  eq('four of ten sold — line stays open', d, { single: false, soldUnits: 4, closed: false, status: null })
}
{
  const d = settleDecision({ quantity: 10, quantitySold: 9, derivedUnits: 10 })
  eq('the last unit closes the line', d, { single: false, soldUnits: 10, closed: true, status: 'sold' })
}
{
  // Oversold (eBay let 11 go on a 10 line): the count is honest, the line closes.
  const d = settleDecision({ quantity: 10, quantitySold: 0, derivedUnits: 11 })
  ok('overselling still closes, and keeps the real count', d.closed && d.soldUnits === 11, JSON.stringify(d))
}

console.log('\nsettleDecision — derived, never incremented (idempotence)\n')
{
  // Run the same settle twice: the second pass must change nothing. This is
  // the property that lets the nightly sync re-read the same 30-day order
  // window forever without a 6-unit line reading 40 sold.
  const first = settleDecision({ quantity: 6, quantitySold: 0, derivedUnits: 2 })
  const second = settleDecision({ quantity: 6, quantitySold: first.soldUnits, derivedUnits: 2 })
  eq('re-settling the same sales is a no-op', second.soldUnits, first.soldUnits)
  eq('and does not close the line', second.closed, false)
}
{
  // The row's own value never goes DOWN either — a sale row pruned from
  // ebay_sales (or a derive that failed to 0) must not resurrect sold stock.
  const d = settleDecision({ quantity: 6, quantitySold: 3, derivedUnits: 0 })
  eq('a lost sale row does not un-sell units', d.soldUnits, 3)
}

console.log('\nsettleDecision — the listing ending returns unsold units to stock\n')
{
  const d = settleDecision({ quantity: 10, quantitySold: 0, derivedUnits: 0, ebayQuantitySold: 3, endedOnEbay: true })
  eq('eBay lifetime QuantitySold settles the count', d.soldUnits, 3)
  eq('units remain + listing over → back in stock', d.status, 'in_stock')
  eq('the line did not close', d.closed, false)
}
{
  const d = settleDecision({ quantity: 3, quantitySold: 0, derivedUnits: 0, ebayQuantitySold: 3, endedOnEbay: true })
  eq('ended with nothing left closes the line', d.status, 'sold')
}
{
  const d = settleDecision({ quantity: 10, quantitySold: 0, derivedUnits: 4, endedOnEbay: false })
  eq('still live on eBay → status untouched', d.status, null)
}

console.log('\nperUnitPrice — the part row quotes a unit, ebay_sales keeps the line\n')
{
  eq('a 3-unit $60 line is $20 a unit', perUnitPrice(60, 3), 20)
  eq('a single unit passes through unchanged', perUnitPrice(60, 1), 60)
  eq('an uneven split rounds to cents', perUnitPrice(100, 3), 33.33)
  eq('no price is null, not zero', perUnitPrice(null, 3), null)
  eq('zero is null too — the spread guards upstream skip it', perUnitPrice(0, 2), null)
  eq('junk units defaults to one unit', perUnitPrice(60, 0), 60)
}

console.log('\navailableQuantity — what eBay is told is on the shelf\n')
{
  eq('a plain part is one', availableQuantity({}), 1)
  eq('a legacy row with nulls is one', availableQuantity({ quantity: null, quantity_sold: null }), 1)
  eq('ten held, four gone → six', availableQuantity({ quantity: 10, quantity_sold: 4 }), 6)
  // The floor: publish is only reached by a line being listed, and eBay
  // rejects a zero-quantity offer — never send it one.
  eq('a sold-out line still floors at one', availableQuantity({ quantity: 5, quantity_sold: 5 }), 1)
  eq('corrupt negative counts floor at one', availableQuantity({ quantity: 2, quantity_sold: 9 }), 1)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
