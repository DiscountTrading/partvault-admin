// Screen-density probe.
//
// Paul, 2026-08-29: "when I go to add a part I have to scroll through several
// screens to see all the fields… this is the same across the board." Adding a
// part is three full pages of scrolling.
//
// Density is an argument nobody wins by eye — one person's "airy" is another's
// "wasteful", and a screenshot makes everything look fine at 50%. So measure it,
// in the two units that actually matter to the person using the app:
//
//   screensTall   documentHeight / viewportHeight. "How many times do I scroll
//                 to see everything?" 1.0 means it fits.
//   pxPerUnit     vertical pixels spent per unit of INFORMATION — one form
//                 field, one inventory row, one sale, one setting. This is the
//                 number to drive down; it is what "efficient" means here.
//
// INVENTORY IS THE BENCHMARK, because Paul named it as the density he wants
// everywhere: "inventory is as efficient as we can make it". Every other screen
// is reported as a multiple of it, so the target is his, not mine.
//
// Also reports the biggest vertical GAPS between adjacent blocks, because
// "too much white space" is a real diagnosis with a real location, and padding
// is usually not where it hides — it is usually one container's margin.
//
//   node scripts/check-density.mjs                 (needs the dev server up)
//   node scripts/check-density.mjs --self-test
//
// ⚠️ Its first version was wrong in three ways; see the self-test cases.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p))

const BASE = process.env.DENSITY_BASE || 'http://localhost:5173'

// Real sizes, not one monitor. Paul's own desktop is ~1872 wide; the laptop and
// the small laptop are where "three pages of scrolling" gets worse, not better.
const VIEWPORTS = [
  { name: 'desktop 1872', width: 1872, height: 950 },
  { name: 'laptop 1440',  width: 1440, height: 820 },
  { name: 'small 1280',   width: 1280, height: 720 },
]

// What counts as one unit of information on each screen. Getting this wrong is
// how the whole report becomes noise, so each is the thing the USER came for.
const SCREENS = [
  { id: 'inventory', unit: 'row',   sel: 'table tbody tr',                    label: 'Inventory (the benchmark)' },
  { id: 'partform',  unit: 'field', sel: 'input, select, textarea',           label: 'Add / edit a part' },
  { id: 'sales',     unit: 'sale',  sel: 'table tbody tr',                    label: 'Sales' },
  { id: 'analytics', unit: 'row',   sel: 'table tbody tr',                    label: 'Analytics — By part' },
  { id: 'settings',  unit: 'control', sel: 'input, select, textarea, button', label: 'Settings' },
  // ⚠ Dashboard's selector was '[data-tile], .tile' and matched NOTHING — it sat
  // in the report showing 0 units and 0 px/unit for days, which reads as "fine"
  // rather than "never measured". Its cards are inline S.card divs inside two
  // grids, so target the grid children.
  { id: 'dashboard', unit: 'card',  sel: 'div[style*="grid"] > div[style*="border-radius"]', label: 'Dashboard' },
  { id: 'bymodel',   unit: 'row',   sel: 'table tbody tr',                    label: 'Analytics — By model' },
  { id: 'bycar',     unit: 'row',   sel: 'table tbody tr',                    label: 'Analytics — By car' },
  { id: 'bulkedit',  unit: 'row',   sel: 'table tbody tr',                    label: 'Bulk edit' },
  { id: 'help',        unit: 'block',   sel: 'h2, h3, p, li',           label: 'Help' },
  { id: 'ops',         unit: 'control', sel: 'input, select, button, table tbody tr', label: 'Ops console' },
  { id: 'histcosts',   unit: 'row',     sel: 'input, select, table tbody tr', label: 'Historical costs' },
  { id: 'spelling',    unit: 'row',     sel: 'table tbody tr, button',  label: 'Tidy spellings' },
  { id: 'containers',  unit: 'row',     sel: 'table tbody tr, input',   label: 'Containers' },
  { id: 'skureconcile',unit: 'row',     sel: 'table tbody tr, button',  label: 'SKU reconcile' },
  { id: 'ebayhistory', unit: 'control', sel: 'input, select, button',   label: 'eBay history upload' },
]

// ── The page-side measurement ───────────────────────────────────────────────
// Runs in the browser. Kept in one function so the self-test can exercise the
// same logic against synthetic DOMs.
const MEASURE = function (unitSel) {
  const doc = document.documentElement

  // Only count units that are actually RENDERED. A hidden tab's inputs are in
  // the DOM and would otherwise inflate the count and flatter the density.
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden'
  }
  const units = [...document.querySelectorAll(unitSel)].filter(visible)

  // The scrollable extent. Measure the SCROLL CONTAINER, not the body: several
  // screens pin their header and scroll only the table body, and measuring the
  // body there reports 1.0 screens for something that scrolls plenty.
  let scroller = doc, best = doc.scrollHeight
  for (const el of document.querySelectorAll('div, main, section')) {
    if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) {
      const s = getComputedStyle(el)
      if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
        if (el.scrollHeight > best) { best = el.scrollHeight; scroller = el }
      }
    }
  }
  const contentHeight = Math.max(doc.scrollHeight, best)

  // Biggest vertical gaps between adjacent siblings — where the air actually is.
  const gaps = []
  const walk = (parent) => {
    const kids = [...parent.children].filter(visible)
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect(), b = kids[i + 1].getBoundingClientRect()
      const gap = b.top - a.bottom
      // Only vertical stacking, and ignore hairlines.
      if (gap > 24 && b.top >= a.bottom) {
        gaps.push({
          gap: Math.round(gap),
          after: (kids[i].tagName + (kids[i].className && typeof kids[i].className === 'string' ? '.' + kids[i].className.split(' ')[0] : '')).slice(0, 40),
          text: (kids[i].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 42),
        })
      }
    }
    for (const k of kids) if (k.children.length) walk(k)
  }
  walk(document.body)
  gaps.sort((x, y) => y.gap - x.gap)

  // Median unit height — the median, not the mean, so one tall outlier (a
  // textarea, a wrapped title) does not misreport the typical row.
  const rects = units.map((u) => u.getBoundingClientRect())
  const heights = rects.map((r) => Math.round(r.height)).filter((h) => h > 0).sort((a, b) => a - b)
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 0

  // ── Layout shape ──────────────────────────────────────────────────────────
  // The vertical numbers alone can't tell you WHY a screen is tall. These can:
  //   columns          how many are laid out side by side. A form in one column
  //                    on a 1872px screen is not a spacing problem, it is a
  //                    layout problem, and no amount of trimming padding fixes it.
  //   widthUsedPct     how much of the horizontal space the page uses at all.
  //   unitPctOfHeight  what share of the scroll height is the actual content
  //                    the user came for. The rest is chrome, labels and air.
  const cols = [...new Set(rects.map((r) => Math.round(r.left / 40) * 40))]
  // ⚠ The first version measured the widest ELEMENT on the page, which is always
  // some full-width wrapper, so every screen reported 100% and the metric was
  // worthless — it hid the actual finding (the part form is capped at 820px on
  // an 1872px monitor). Measure the span of the UNITS themselves: that is the
  // width the content really occupies.
  const minLeft = rects.length ? Math.min(...rects.map((r) => r.left)) : 0
  const maxRight = rects.length ? Math.max(...rects.map((r) => r.right)) : 0
  const unitPx = rects.reduce((n, r) => n + r.height, 0)

  // ── The two numbers that do not move with the mock data ───────────────────
  // unitPctOfHeight is honest only when the screen is full of rows: with six
  // sample sales, fixed chrome is most of the page and the screen looks far
  // worse than it is. These two do not have that problem, and they are what the
  // user actually experiences:
  //
  //   chromeBeforeContent  pixels spent before the FIRST row/field appears —
  //                        the toolbar, filters and summary tiles you scroll
  //                        past every single time, whatever the row count.
  //   unitsInFirstScreen   how many rows/fields you can see without scrolling.
  //                        For a 24-field form this IS the "how many pages"
  //                        answer, and it is independent of the data.
  const scrollTop = window.scrollY
  const tops = rects.map((r) => r.top + scrollTop)
  const firstY = tops.length ? Math.min(...tops) : 0
  const inFirst = rects.filter((r) => r.top + scrollTop < window.innerHeight).length

  return {
    contentHeight,
    unitCount: units.length,
    medianUnitHeight: median,
    columns: cols.length,
    widthUsedPct: Math.round(((maxRight - minLeft) / window.innerWidth) * 100),
    contentWidthPx: Math.round(maxRight - minLeft),
    unitPctOfHeight: contentHeight ? Math.round((unitPx / contentHeight) * 100) : 0,
    chromeBeforeContent: Math.round(firstY),
    chromePctOfViewport: Math.round((firstY / window.innerHeight) * 100),
    unitsInFirstScreen: inFirst,
    gaps: gaps.slice(0, 6),
    totalGapPx: gaps.reduce((n, g) => n + g.gap, 0),
  }
}

// ── Self-test: the checker has to be seen to be right ───────────────────────
// Every case here is a way the FIRST version of this script was wrong.
if (process.argv.includes('--self-test')) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 600 })
  let pass = 0, fail = 0
  const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) } }

  const run = async (html, sel) => {
    await page.setContent(`<body style="margin:0">${html}</body>`)
    return page.evaluate(MEASURE, sel)
  }

  // 1. A hidden tab's fields must not count — they would flatter the density.
  let r = await run(`<input><input><div style="display:none"><input><input><input></div>`, 'input')
  ok('hidden inputs are not counted as rendered fields', r.unitCount === 2, `counted ${r.unitCount}`)

  // 2. Median, not mean: one tall field must not misreport the typical row.
  r = await run(`<input style="height:30px"><input style="height:30px"><input style="height:30px"><textarea style="height:400px"></textarea>`, 'input, textarea')
  ok('one tall textarea does not drag the typical field height up', r.medianUnitHeight === 30, `got ${r.medianUnitHeight}`)

  // 3. An inner scroll container must be found — a pinned header with a
  //    scrolling body reported 1.0 screens before this.
  r = await run(`<div style="height:300px;overflow-y:auto"><div style="height:2400px"></div></div>`, 'div')
  ok('an inner scroll container is measured, not just the body', r.contentHeight >= 2400, `got ${r.contentHeight}`)

  // 4. Gaps are found and attributed, and hairline spacing is ignored.
  r = await run(`<div><p style="height:20px;margin:0">a</p><p style="height:20px;margin:120px 0 0">b</p></div>`, 'p')
  ok('a large vertical gap is reported', r.gaps.length === 1 && r.gaps[0].gap === 120, JSON.stringify(r.gaps))
  r = await run(`<div><p style="height:20px;margin:0 0 8px">a</p><p style="height:20px;margin:0">b</p></div>`, 'p')
  ok('ordinary 8px spacing is not reported as waste', r.gaps.length === 0, JSON.stringify(r.gaps))

  // 5. Zero units must not divide by zero and claim infinite density.
  r = await run(`<div style="height:500px"></div>`, 'input')
  ok('a screen with no units reports zero, not Infinity', r.unitCount === 0 && r.medianUnitHeight === 0)

  console.log(`\nself-test: ${pass} passed, ${fail} failed\n`)
  await browser.close()
  process.exit(fail ? 1 : 0)
}

// ── The run ─────────────────────────────────────────────────────────────────
if (!CHROME) { console.error('Chrome not found.'); process.exit(1) }

// `--detail <screen>` — the vertical anatomy of one screen. The summary says a
// screen is too tall; this says which blocks are spending the height, and how
// the fields are actually distributed across rows (a form can report seven
// columns and still put most fields on a row of their own).
const detailArg = process.argv.indexOf('--detail')
if (detailArg !== -1) {
  const id = process.argv[detailArg + 1] || 'partform'
  const sc = SCREENS.find((s) => s.id === id) || SCREENS[1]
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1872, height: 950 })
  await page.goto(`${BASE}/harness.html?screen=${sc.id}`, { waitUntil: 'networkidle0' })
  await new Promise((r) => setTimeout(r, 500))
  const d = await page.evaluate((sel) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return (r.width || r.height) && getComputedStyle(el).display !== 'none' }
    // Top-level vertical blocks: the direct children of the tallest container,
    // which is what a reader perceives as "the sections of this page".
    let host = document.body
    while (host.children.length === 1 && host.firstElementChild.children.length) host = host.firstElementChild
    const blocks = [...host.children].filter(vis).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        h: Math.round(r.height),
        fields: el.querySelectorAll('input, select, textarea').length,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 52),
      }
    })
    // How many fields share each row (grouped by rounded y).
    const units = [...document.querySelectorAll(sel)].filter(vis)
    const byRow = {}
    for (const u of units) {
      const y = Math.round(u.getBoundingClientRect().top / 12) * 12
      byRow[y] = (byRow[y] || 0) + 1
    }
    const counts = Object.values(byRow)
    const hist = {}
    for (const c of counts) hist[c] = (hist[c] || 0) + 1
    return { blocks, rows: counts.length, hist, fields: units.length }
  }, sc.sel)
  console.log(`\n\x1b[1m${sc.label} — vertical anatomy at 1872x950\x1b[0m\n`)
  for (const b of d.blocks) {
    console.log(`  ${String(b.h).padStart(5)}px  ${String(b.fields + ' fields').padStart(9)}   ${b.text || '(no text)'}`)
  }
  console.log(`\n  ${d.fields} fields over ${d.rows} rows. Fields per row:`)
  for (const [n, times] of Object.entries(d.hist).sort((a, b) => +a[0] - +b[0])) {
    console.log(`      ${times} row(s) with ${n} field${n === '1' ? '' : 's'}${n === '1' ? '   <- a whole row for one field' : ''}`)
  }
  console.log()
  await browser.close()
  process.exit(0)
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
const results = []

for (const vp of VIEWPORTS) {
  const page = await browser.newPage()
  await page.setViewport({ width: vp.width, height: vp.height })
  for (const sc of SCREENS) {
    try {
      await page.goto(`${BASE}/harness.html?screen=${sc.id}`, { waitUntil: 'networkidle0', timeout: 20000 })
      await new Promise((r) => setTimeout(r, 500))
      const m = await page.evaluate(MEASURE, sc.sel)
      results.push({
        viewport: vp.name, vpHeight: vp.height, screen: sc.id, label: sc.label, unit: sc.unit,
        screensTall: +(m.contentHeight / vp.height).toFixed(2),
        ...m,
      })
    } catch (e) {
      results.push({ viewport: vp.name, screen: sc.id, label: sc.label, error: String(e.message).slice(0, 80) })
    }
  }
  await page.close()
}
await browser.close()

// ── Report ──────────────────────────────────────────────────────────────────
const fmt = (n) => String(n).padStart(6)
for (const vp of VIEWPORTS) {
  const rows = results.filter((r) => r.viewport === vp.name && !r.error)
  const bench = rows.find((r) => r.screen === 'inventory')
  console.log(`\n\x1b[1m${vp.name}  (${vp.width}x${vp.height})\x1b[0m`)
  console.log('  screen                       screens tall  px/unit  cols   chrome first   seen w/o    width used')
  console.log('                                                              (before content)  scrolling')
  for (const r of rows) {
    // A screen whose unit selector matched nothing is NOT a screen that measured
    // well — it is one that was not measured. Printing zeros for it reads as
    // "fine", which is exactly how the Dashboard sat unmeasured in this report.
    if (!r.unitCount) {
      console.log(`  ${r.label.padEnd(28)}\x1b[33m  not measured — its unit selector matched nothing (needs data stubs)\x1b[0m`)
      continue
    }
    const flag = r.screensTall > 1.5 ? ' \x1b[31m<<\x1b[0m' : ''
    const chrome = `${r.chromeBeforeContent}px (${r.chromePctOfViewport}%)`
    const seen = `${r.unitsInFirstScreen}/${r.unitCount}`
    const wid = `${r.contentWidthPx}px (${r.widthUsedPct}%)`
    console.log(`  ${r.label.padEnd(28)}${fmt(r.screensTall)}${fmt(r.medianUnitHeight)}${fmt(r.columns)}${String(chrome).padStart(17)}${String(seen).padStart(12)}${String(wid).padStart(16)}${flag}`)
  }
  if (bench) console.log(`  \x1b[2m(chrome first = pixels scrolled past before the first row/field appears, every visit)\x1b[0m`)
}

console.log('\n\x1b[1mWhere the vertical space goes\x1b[0m  (largest gaps, desktop 1872)')
for (const r of results.filter((x) => x.viewport === 'desktop 1872' && !x.error)) {
  if (!r.gaps?.length) continue
  console.log(`\n  ${r.label} — ${r.totalGapPx}px total in gaps over 24px`)
  for (const g of r.gaps) console.log(`      ${String(g.gap).padStart(4)}px after  ${g.after.padEnd(30)} ${g.text ? '“' + g.text + '”' : ''}`)
}

const errs = results.filter((r) => r.error)
if (errs.length) {
  console.log('\n\x1b[33mnot measured\x1b[0m')
  for (const e of errs) console.log(`  ${e.screen}: ${e.error}`)
}
console.log()
