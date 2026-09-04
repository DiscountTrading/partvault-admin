import { partEffectiveCost } from './constants.js'

// ═══════════════════════════════════════════════════════════════════════════
//  Group a set of parts by any key and measure the group.
//
//  Extracted so the Compare cards and the By-model table cannot drift apart.
//  Profit, margin and days-to-sell are already computed in three places in this
//  app; a fourth private copy is how a screen ends up quietly disagreeing with
//  the one next to it about what a category earned.
//
//  The definitions here are the ones the rest of the app already uses:
//
//    cost         partEffectiveCost — the same basis the Inventory and Sales
//                 screens quote, so a card's cost matches the parts inside it.
//    daysToSell   sold_date − (acquired_date ?? created_at). Identical to the
//                 part_insights view's days_to_sell, deliberately.
//    margin       profit as a share of REVENUE, not of cost.
//
//  Everything is per-group and independent of how the caller chose the groups,
//  so the same function serves "by category", "by make", "by condition" and
//  "by donor car" without a branch.
// ═══════════════════════════════════════════════════════════════════════════

export const daysBetween = (from, to) => {
  if (!from || !to) return null
  const n = Math.floor((new Date(to) - new Date(from)) / 86400000)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// A part row is a stock LINE: `quantity` units acquired (1 for a dismantled
// part — each is unique), `quantitySold` units gone. These resolve a line into
// UNIT counts so the metrics below measure sales, not rows — a 50-unit buy-in
// line that sold out is 50 sales, not 1. For quantity-1 parts every value is
// identical to the old row-based numbers, which is what keeps this change
// invisible to a dismantler.
const lineQty = (p) => Math.max(1, Math.floor(+p.quantity) || 1)
const unitsSoldOf = (p) => {
  const sold = Math.max(0, Math.floor(+p.quantitySold) || 0)
  // A closed line is at least one sale even where quantitySold was never
  // maintained (every part sold before multi-quantity existed).
  if (p.status === 'sold') return Math.max(1, sold)
  return Math.min(sold, lineQty(p))
}

/**
 * @param {Array}    parts    parts as the app holds them (camelCase)
 * @param {Function} keyFn    part -> group key, or null/'' to exclude the part
 * @param {object}   costing  store cost settings, passed to partEffectiveCost
 * @param {Function} [labelFn] group key -> display label (defaults to the key)
 * @returns {Array} one row per group, richest first by net profit
 */
export function groupMetrics(parts, keyFn, costing, labelFn) {
  const groups = new Map()
  for (const p of parts || []) {
    if (p.deletedAt) continue
    const key = keyFn(p)
    // A part with no value for this dimension is EXCLUDED rather than bucketed
    // into "Other": an "Other" card that silently mixes uncategorised parts with
    // real ones is worse than a smaller, honest set of cards. The caller is told
    // how many were skipped so it can say so.
    if (key == null || key === '') continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }

  return [...groups.entries()].map(([key, gp]) => {
    const closed = gp.filter((p) => p.status === 'sold')
    const open = gp.filter((p) => p.status === 'in_stock' || p.status === 'listed')
    const costOf = (p) => +partEffectiveCost(p, costing).value || 0

    // Units, not rows. On a multi-quantity line soldPrice is the PER-UNIT
    // price (the sync stores it that way) and the recorded costs cover the
    // whole line — so revenue multiplies out by units, a closed line carries
    // its full cost, and a line still selling down carries the sold share.
    const soldUnits = gp.reduce((a, p) => a + unitsSoldOf(p), 0)
    const totalUnits = gp.reduce((a, p) => a + lineQty(p), 0)
    const revenue = gp.reduce((a, p) => a + unitsSoldOf(p) * (+p.soldPrice || 0), 0)
    const cost = closed.reduce((a, p) => a + costOf(p), 0)
      + open.reduce((a, p) => a + costOf(p) * (unitsSoldOf(p) / lineQty(p)), 0)
    const netProfit = revenue - cost
    const dts = closed.map((p) => daysBetween(p.acquiredDate || p.createdAt, p.soldDate)).filter((v) => v != null)

    return {
      key,
      label: labelFn ? labelFn(key, gp) : key,
      parts: gp.length,
      sold: soldUnits,
      unsold: open.reduce((a, p) => a + (lineQty(p) - unitsSoldOf(p)), 0),
      // Of the units in this group, how many have actually sold.
      sellThrough: totalUnits ? (soldUnits / totalUnits) * 100 : null,
      revenue,
      cost,
      netProfit,
      // Per-unit profit is what makes categories comparable when one has 400
      // parts and another has 6 — total profit alone just ranks them by size.
      profitPerSold: soldUnits ? netProfit / soldUnits : null,
      margin: revenue > 0 ? (netProfit / revenue) * 100 : null,
      // Median as well as mean: one part that sat for three years drags an
      // average badly, and "how long does this kind of part usually take" is
      // the median question.
      avgDaysToSell: dts.length ? Math.round(mean(dts)) : null,
      medianDaysToSell: dts.length ? Math.round(median(dts)) : null,
      // Only counts parts we could date at all, so the caller can say when a
      // figure rests on three of forty parts.
      datedSold: dts.length,
      // Money still sitting on the shelf at its asking price — remaining
      // units of a part-sold line included.
      untapped: open.reduce((a, p) => a + (lineQty(p) - unitsSoldOf(p)) * (+p.listPrice || +p.list_price || 0), 0),
    }
  }).sort((a, b) => b.netProfit - a.netProfit)
}

/** How many parts have no value for this dimension — so a screen can say so. */
export function ungrouped(parts, keyFn) {
  let n = 0
  for (const p of parts || []) {
    if (p.deletedAt) continue
    const k = keyFn(p)
    if (k == null || k === '') n++
  }
  return n
}

// The dimensions a set of parts can be compared along. Kept here rather than in
// the component so the list is one thing, and so a test can prove each key
// actually resolves against a real part.
export const COMPARE_DIMENSIONS = [
  { id: 'category',    label: 'Category',     of: (p) => p.category || '' },
  { id: 'subcategory', label: 'Part type',    of: (p) => p.subcategory || '' },
  { id: 'make',        label: 'Make',         of: (p) => p.make || '' },
  { id: 'model',       label: 'Model',        of: (p) => (p.make && p.model ? `${p.make} ${p.model}` : '') },
  { id: 'condition',   label: 'Condition',    of: (p) => p.condition || '' },
  { id: 'car',         label: 'Donor car',    of: (p) => p.car_id || p.carId || '' },
]
