// ═══════════════════════════════════════════════════════════════════════════
//  Financial years, which are not the same year in every country.
//
//    AU  1 Jul – 30 Jun     "FY2026" = 1 Jul 2025 → 30 Jun 2026
//    NZ  1 Apr – 31 Mar     same convention, named for the closing year
//    GB  6 Apr –  5 Apr     the personal tax year, and it genuinely starts on
//                           the SIXTH — a leftover from the 1752 calendar
//                           change. Written "2025/26".
//    US  1 Jan – 31 Dec     the calendar year for almost every small business
//    CA  1 Jan – 31 Dec     for individuals; incorporated businesses may pick
//                           their own, which is why this is overridable
//
//  The default follows the store's eBay marketplace, because that is the country
//  it trades and files in. It is overridable per store, since a business can run
//  a substituted accounting period and an incorporated Canadian one usually does.
//
//  ── Why the timezone argument is not optional ─────────────────────────────
//  A sale at 11pm on 30 June in Brisbane is 1pm on 30 June UTC — same day. But a
//  sale at 8am on 1 July in Brisbane is 10pm on 30 JUNE UTC, and counting it in
//  UTC puts it in the previous financial year. On the last night of the year that
//  is the difference between a sale being in this return or the next one, so the
//  boundaries are computed in the STORE's timezone, not the browser's and not UTC.
// ═══════════════════════════════════════════════════════════════════════════

// startMonth is 1-12, startDay is the day of that month the year begins on.
export const FY_STARTS = {
  AU: { startMonth: 7, startDay: 1,  nameBy: 'end',   label: 'Australia — 1 Jul to 30 Jun' },
  NZ: { startMonth: 4, startDay: 1,  nameBy: 'end',   label: 'New Zealand — 1 Apr to 31 Mar' },
  GB: { startMonth: 4, startDay: 6,  nameBy: 'split', label: 'United Kingdom — 6 Apr to 5 Apr' },
  US: { startMonth: 1, startDay: 1,  nameBy: 'start', label: 'United States — calendar year' },
  CA: { startMonth: 1, startDay: 1,  nameBy: 'start', label: 'Canada — calendar year' },
}
export const DEFAULT_FY_COUNTRY = 'AU'

/** The FY rule for a store: an explicit override wins, else the marketplace's country. */
export function fyConfig(settings = {}, country = DEFAULT_FY_COUNTRY) {
  const o = settings?.financialYear
  if (o && +o.startMonth >= 1 && +o.startMonth <= 12 && +o.startDay >= 1 && +o.startDay <= 31) {
    return {
      startMonth: +o.startMonth,
      startDay: +o.startDay,
      nameBy: o.nameBy || (FY_STARTS[country]?.nameBy ?? 'end'),
      custom: true,
    }
  }
  return { ...(FY_STARTS[country] || FY_STARTS[DEFAULT_FY_COUNTRY]), custom: false }
}

// ── Timezone-correct calendar arithmetic ────────────────────────────────────
// Intl gives the wall-clock parts of an instant in a named zone; that is the only
// dependency-free way to ask "what is the local date there right now".
const partsIn = (ms, tz) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p = {}
  for (const { type, value } of f.formatToParts(ms)) if (type !== 'literal') p[type] = +value
  return p
}

// The offset (ms) of a zone at an instant: local wall clock minus UTC wall clock.
const offsetAt = (ms, tz) => {
  const p = partsIn(ms, tz)
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return asUTC - Math.floor(ms / 1000) * 1000
}

/**
 * The instant at which a given local wall-clock time occurs in `tz`.
 * Two passes: guess with the offset at the naive instant, then correct using the
 * offset actually in force at the guess. That second pass is what makes a
 * boundary land correctly when the year starts on the far side of a DST change,
 * which it does for the UK and the US.
 */
export function zonedTimeToMs(y, m, d, tz, h = 0, min = 0, s = 0) {
  const naive = Date.UTC(y, m - 1, d, h, min, s)
  let ms = naive - offsetAt(naive, tz)
  ms = naive - offsetAt(ms, tz)
  return ms
}

/** Today's local date in `tz`. */
export const localToday = (tz, at = Date.now()) => {
  const p = partsIn(at, tz)
  return { year: p.year, month: p.month, day: p.day }
}

/**
 * The financial year containing `at`.
 * @returns {{fromMs, toMs, label, startYear, endYear}} toMs is the last
 *          millisecond of the final day, so a range test can be inclusive.
 */
export function financialYearOf(at, cfg, tz = 'UTC', offsetYears = 0) {
  const { startMonth, startDay } = cfg
  const t = localToday(tz, at)
  // Before the start date, we are still in the year that began last calendar year.
  const afterStart = t.month > startMonth || (t.month === startMonth && t.day >= startDay)
  const startYear = (afterStart ? t.year : t.year - 1) + offsetYears

  const fromMs = zonedTimeToMs(startYear, startMonth, startDay, tz)
  // Ends the millisecond before the next one begins — never "start + 365 days",
  // which is wrong in a leap year and wrong across a DST change.
  const nextMs = zonedTimeToMs(startYear + 1, startMonth, startDay, tz)
  return {
    fromMs,
    toMs: nextMs - 1,
    startYear,
    endYear: startYear + 1,
    label: fyLabel(startYear, cfg),
  }
}

/** How the country writes it. Getting this wrong makes the figure untrustworthy. */
export function fyLabel(startYear, cfg) {
  const end = startYear + 1
  switch (cfg.nameBy) {
    case 'start': return String(startYear)                                  // US/CA: 2026
    case 'split': return `${startYear}/${String(end).slice(-2)}`             // GB: 2025/26
    case 'end':
    default:      return `FY${end}`                                          // AU/NZ: FY2026
  }
}

/** This FY and the previous one, ready for a period picker. */
export function fyOptions(at, cfg, tz = 'UTC') {
  const cur = financialYearOf(at, cfg, tz, 0)
  const prev = financialYearOf(at, cfg, tz, -1)
  return [
    { id: 'fy-this', ...cur, name: `This FY · ${cur.label}` },
    { id: 'fy-last', ...prev, name: `Last FY · ${prev.label}` },
  ]
}

/** Plain-English description of the rule, for Settings. */
export function describeFy(cfg) {
  const MON = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']
  const endM = cfg.startMonth === 1 ? 12 : cfg.startMonth - 1
  // The day before the start date, expressed as the last day of the year.
  const endD = cfg.startDay === 1 ? 'the last day of' : `${cfg.startDay - 1} `
  return cfg.startDay === 1
    ? `1 ${MON[cfg.startMonth]} to ${endD} ${MON[endM]}`
    : `${cfg.startDay} ${MON[cfg.startMonth]} to ${endD}${MON[cfg.startMonth]} the next year`
}
