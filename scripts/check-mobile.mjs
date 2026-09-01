// Mobile screen-coverage probe for the ADMIN app on a phone.
//
// Paul, 2026-09-01: "too much information on it… must look cleaner and provide
// all necessary information."
//
// The target, and where it comes from. There is no single official number, so
// these are the established heuristics stated as thresholds we can measure:
//
//   contentPct  ≥ 60%   Share of the FIRST viewport given to the thing the user
//                       came for. Apple's own chrome on an 844pt screen is a
//                       44pt nav bar + 49pt tab bar ≈ 11%; the rest is content.
//                       Allowing a search/filter bar on top, 60% is generous.
//   firstItemY  < 40%   You should see real content without scrolling. A list
//                       whose first row sits below the fold reads as an empty
//                       app.
//   itemsFirst  ≥ 4     A list that shows fewer than four items per screen is a
//                       page-turner, not a list.
//   controls    ≤ 4     Controls stacked above the content before you reach it.
//
//   node scripts/check-mobile.mjs
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
const CHROME=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p))
const BASE = process.env.DENSITY_BASE || 'http://localhost:5173'
const VP = { width: 390, height: 844 }
const SCREENS = ['inventory','sales','analytics','dashboard','settings']

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' })
const rows = []
for (const s of SCREENS) {
  const p = await b.newPage()
  await p.setViewport({ ...VP, isMobile: true, hasTouch: true })
  await p.goto(`${BASE}/harness.html?screen=${s}`, { waitUntil: 'networkidle0' })
  await new Promise(r => setTimeout(r, 700))
  rows.push({ s, ...await p.evaluate((vh) => {
    // A content item: tall enough to be a card/row, with >=3 text leaves, and
    // with at least two siblings the same height (i.e. it repeats).
    const isItem = (el) => {
      const r = el.getBoundingClientRect()
      // 150, not 200: a 2-up stat grid on a 390px phone gives ~180px cards, and
      // a 200px floor silently excluded the whole Dashboard and reported it as 0%
      // content — the metric said "terrible" where it meant "not measured".
      if (r.height < 50 || r.width < 150) return false
      const leaves = [...el.querySelectorAll('*')].filter(e => !e.children.length && (e.textContent||'').trim())
      if (leaves.length < 3) return false
      const sibs = [...(el.parentElement?.children||[])]
        .filter(k => Math.abs(k.getBoundingClientRect().height - r.height) < 40)
      return sibs.length >= 3
    }
    const items = [...document.querySelectorAll('div,tr,li')].filter(isItem)
    // Outermost only — a card and its inner wrapper both match otherwise.
    const outer = items.filter(el => !items.some(o => o !== el && o.contains(el)))
    const ys = outer.map(el => el.getBoundingClientRect().top + scrollY)
    const firstY = ys.length ? Math.min(...ys) : null
    const inFirst = outer.filter(el => {
      const r = el.getBoundingClientRect()
      return r.top + scrollY < vh && r.bottom + scrollY > 0
    }).length
    const controls = [...document.querySelectorAll('button,select,input')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.height > 0 && (firstY == null || r.top + scrollY < firstY) }).length
    return {
      firstY: firstY == null ? null : Math.round(firstY),
      itemsFirst: inFirst,
      itemH: outer.length ? Math.round(outer[0].getBoundingClientRect().height) : null,
      controls,
      contentPct: firstY == null ? 0 : Math.max(0, Math.round(((vh - Math.min(firstY, vh)) / vh) * 100)),
      total: document.documentElement.scrollHeight,
    }
  }, VP.height) })
  await p.close()
}
await b.close()

const bad = (v, ok) => ok ? String(v) : `\x1b[31m${v}\x1b[0m`
console.log(`\n\x1b[1mAdmin on a phone — ${VP.width}x${VP.height}\x1b[0m`)
console.log('  target:            content ≥60%   1st item <40% down   ≥4 items   ≤4 controls\n')
console.log('  screen        content%   1st item at   items/screen   controls above   item h')
for (const r of rows) {
  const pctOk = r.contentPct >= 60
  const yOk = r.firstY != null && r.firstY < VP.height * 0.4
  const nOk = r.itemsFirst >= 4
  const cOk = r.controls <= 4
  console.log(`  ${r.s.padEnd(13)}${bad((r.contentPct+'%').padStart(7), pctOk)}${bad(String(r.firstY==null?'—':r.firstY+'px').padStart(14), yOk)}${bad(String(r.itemsFirst).padStart(15), nOk)}${bad(String(r.controls).padStart(17), cOk)}${String(r.itemH??'—').padStart(9)}`)
}
console.log()
