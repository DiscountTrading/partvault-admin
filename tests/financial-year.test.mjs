// ═══════════════════════════════════════════════════════════════════════════
//  Financial years — which return a sale lands in.
//
//  Every assertion here is a boundary, because the middle of a financial year is
//  never wrong. The cases that matter are the last night of the year, the leap
//  day, the DST changeover, and the UK's 6 April — and each of those is a sale
//  counted in the wrong tax return if it is off by one.
//
//  Run: node tests/financial-year.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import {
  FY_STARTS, fyConfig, financialYearOf, fyLabel, fyOptions, zonedTimeToMs, describeFy,
} from '../src/lib/financialYear.js'

let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) } }
const eq = (n, got, want) => ok(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const AU = fyConfig({}, 'AU'), GB = fyConfig({}, 'GB'), US = fyConfig({}, 'US')
const SYD = 'Australia/Sydney', LON = 'Europe/London', NY = 'America/New_York'
// A readable local date, so a failure says when rather than a 13-digit number.
const local = (ms, tz) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(ms).replace(',', '')

console.log('\nThe rule per country\n')
eq('Australia starts 1 July', `${AU.startDay}/${AU.startMonth}`, '1/7')
eq('the UK starts on the SIXTH of April, not the first', `${GB.startDay}/${GB.startMonth}`, '6/4')
eq('the US is the calendar year', `${US.startDay}/${US.startMonth}`, '1/1')
eq('an unknown country falls back to the AU default', fyConfig({}, 'ZZ').startMonth, 7)

console.log('\nNaming, because the same year has different names\n')
eq('AU names a year for the year it ENDS', fyLabel(2025, AU), 'FY2026')
eq('the UK splits it', fyLabel(2025, GB), '2025/26')
eq('the US just uses the year', fyLabel(2026, US), '2026')

console.log('\nWhich year is a given day in? (Australia, Sydney time)\n')
{
  // Mid-year: unambiguous.
  const y = financialYearOf(Date.parse('2026-03-15T00:00:00+11:00'), AU, SYD)
  eq('March 2026 is in FY2026', y.label, 'FY2026')
  eq('which began 1 July 2025', local(y.fromMs, SYD).slice(0, 10), '2025-07-01')
  eq('and ends 30 June 2026', local(y.toMs, SYD).slice(0, 10), '2026-06-30')
}
{
  // THE boundary. 30 June 23:59 local and 1 July 00:00 local are different years.
  const last = financialYearOf(Date.parse('2026-06-30T23:59:00+10:00'), AU, SYD)
  const first = financialYearOf(Date.parse('2026-07-01T00:00:00+10:00'), AU, SYD)
  eq('11:59pm on 30 June is still FY2026', last.label, 'FY2026')
  eq('midnight on 1 July is FY2027', first.label, 'FY2027')
  ok('and the two years touch with no gap and no overlap', first.fromMs === last.toMs + 1,
    `${last.toMs} → ${first.fromMs}`)
}
{
  // The failure this whole timezone argument exists to prevent. 8am on 1 July in
  // Sydney is 10pm on 30 JUNE in UTC — counted in UTC it is the previous year.
  const ms = Date.parse('2026-07-01T08:00:00+10:00')
  eq('8am 1 July Sydney is FY2027 in Sydney', financialYearOf(ms, AU, SYD).label, 'FY2027')
  eq('and that instant really is still 30 June in UTC', local(ms, 'UTC').slice(0, 10), '2026-06-30')
  // Left as a fact rather than a bug: it shows the choice of zone decides the year.
  eq('so computing it in UTC would put it in FY2026', financialYearOf(ms, AU, 'UTC').label, 'FY2026')
}

console.log('\nThe UK, where the year starts on the 6th\n')
{
  eq('5 April 2026 is still 2025/26', financialYearOf(Date.parse('2026-04-05T12:00:00Z'), GB, LON).label, '2025/26')
  eq('6 April 2026 begins 2026/27', financialYearOf(Date.parse('2026-04-06T12:00:00Z'), GB, LON).label, '2026/27')
  const y = financialYearOf(Date.parse('2026-06-01T12:00:00Z'), GB, LON)
  eq('the year runs from 6 April', local(y.fromMs, LON).slice(0, 10), '2026-04-06')
  eq('to 5 April', local(y.toMs, LON).slice(0, 10), '2027-04-05')
}
{
  // British Summer Time begins in late March, so a 6 April boundary is always on
  // the far side of a DST change from the year's other end. A naive
  // "start + 365 days" lands an hour out; this must be midnight exactly.
  const y = financialYearOf(Date.parse('2026-06-01T12:00:00Z'), GB, LON)
  eq('the year begins at local midnight, DST or not', local(y.fromMs, LON).slice(11), '00:00')
  eq('and ends at 23:59 local', local(y.toMs, LON).slice(11), '23:59')
}

console.log('\nThe US calendar year, across its own DST\n')
{
  const y = financialYearOf(Date.parse('2026-08-01T12:00:00Z'), US, NY)
  eq('starts 1 January', local(y.fromMs, NY).slice(0, 10), '2026-01-01')
  eq('ends 31 December', local(y.toMs, NY).slice(0, 10), '2026-12-31')
  eq('at local midnight', local(y.fromMs, NY).slice(11), '00:00')
}

console.log('\nLeap years — the length is never assumed\n')
{
  // FY2024 (AU) contains 29 Feb 2024, so it is a day longer than FY2023.
  const leap = financialYearOf(Date.parse('2024-01-15T00:00:00+11:00'), AU, SYD)
  const plain = financialYearOf(Date.parse('2023-01-15T00:00:00+11:00'), AU, SYD)
  const days = (y) => Math.round((y.toMs + 1 - y.fromMs) / 86400000)
  eq('the leap financial year is 366 days', days(leap), 366)
  eq('and an ordinary one is 365', days(plain), 365)
}

console.log('\nA store that keeps its own year\n')
{
  const cfg = fyConfig({ financialYear: { startMonth: 10, startDay: 1 } }, 'AU')
  eq('the override wins over the country', cfg.startMonth, 10)
  ok('and is flagged as custom', cfg.custom === true)
  const y = financialYearOf(Date.parse('2026-11-15T00:00:00+11:00'), cfg, SYD)
  eq('November 2026 is in the year that began 1 Oct 2026', local(y.fromMs, SYD).slice(0, 10), '2026-10-01')
  eq('ending 30 Sept 2027', local(y.toMs, SYD).slice(0, 10), '2027-09-30')
}
{
  // Junk must not silently become a working year with the wrong dates.
  eq('a month of 13 is ignored', fyConfig({ financialYear: { startMonth: 13, startDay: 1 } }, 'AU').startMonth, 7)
  eq('a day of 0 is ignored', fyConfig({ financialYear: { startMonth: 7, startDay: 0 } }, 'AU').startDay, 1)
  eq('an empty override is ignored', fyConfig({ financialYear: {} }, 'GB').startDay, 6)
}

console.log('\nzonedTimeToMs — the primitive under all of it\n')
{
  eq('midnight in Sydney in winter (AEST, +10)',
    local(zonedTimeToMs(2026, 7, 1, SYD), SYD), '2026-07-01 00:00')
  eq('midnight in Sydney in summer (AEDT, +11)',
    local(zonedTimeToMs(2026, 1, 1, SYD), SYD), '2026-01-01 00:00')
  eq('midnight in London in BST', local(zonedTimeToMs(2026, 6, 1, LON), LON), '2026-06-01 00:00')
  eq('midnight in London in GMT', local(zonedTimeToMs(2026, 12, 1, LON), LON), '2026-12-01 00:00')
  // ⚠ These two are the reason zonedTimeToMs makes a SECOND pass. On Sydney's
  // DST transition days the naive guess uses the offset in force at the UTC
  // instant, which is the wrong side of the change: 5 April comes out an hour
  // late, and 4 October lands on the PREVIOUS DAY entirely. A financial year
  // starting on either date would be a day out.
  //
  // My first version of this test used the UK's 29 March, where both the one-
  // and two-pass answers agree — it passed while proving nothing, and a planted
  // fault removing the second pass went undetected.
  eq('midnight on the day Sydney clocks go BACK (would be 01:00 with one pass)',
    local(zonedTimeToMs(2026, 4, 5, SYD), SYD), '2026-04-05 00:00')
  eq('midnight on the day Sydney clocks go FORWARD (would be the day before)',
    local(zonedTimeToMs(2026, 10, 4, SYD), SYD), '2026-10-04 00:00')
  eq('and the UK transition day, where both agree',
    local(zonedTimeToMs(2026, 3, 29, LON), LON), '2026-03-29 00:00')
}

console.log('\nThe picker options\n')
{
  const [thisFy, lastFy] = fyOptions(Date.parse('2026-03-15T00:00:00+11:00'), AU, SYD)
  eq('this FY', thisFy.name, 'This FY · FY2026')
  eq('last FY', lastFy.name, 'Last FY · FY2025')
  ok('and they are adjacent, not overlapping', lastFy.toMs + 1 === thisFy.fromMs)
}

console.log('\nHow it reads in Settings\n')
eq('Australia', describeFy(AU), '1 July to the last day of June')
eq('the UK', describeFy(GB), '6 April to 5 April the next year')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
