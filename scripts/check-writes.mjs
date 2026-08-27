// Silent-write guard.
//
// supabase-js NEVER throws. A missing table, a revoked grant, a statement
// timeout and a row filtered out by RLS all come back as a resolved
// `{ data, error }`. So this line is not the save it looks like:
//
//     await sb.from('stores').update({ settings: next }).eq('id', storeId)
//
// It reports success whether it wrote, was refused, or never reached the
// database. And this one is worse, because it DESTROYS data:
//
//     const { data: cur } = await sb.from('stores').select('settings')...
//     await sb.from('stores').update({ settings: { ...(cur?.settings || {}), k: v } })
//
// A failed read makes `cur` null, the spread collapses to `{}`, and the update
// replaces the whole column with one key. That shipped in eleven places.
//
// This gate is deliberately NARROW. It looks only at WRITES — insert, update,
// upsert, delete — because a default is safe to render with and never to write
// from. A read whose error is ignored renders an empty list; a write whose
// error is ignored tells the user their work is saved when it is not.
//
//   node scripts/check-writes.mjs
//   node scripts/check-writes.mjs --self-test
//
// The self-test exists because the first version of the equivalent gate on
// another project matched nothing at all and was green for a week. A gate that
// has never been seen to fail is not known to work.
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['src', 'supabase/functions']
const WRITES = ['insert', 'update', 'upsert', 'delete']

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(js|jsx|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

// Strip line and block comments so a documented example (this file's own header,
// or the doc comment in src/lib/storeSettings.js) is not reported as code.
// Crude but sufficient: it only ever needs to stop a `//` line counting.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_, p) => p)

// One statement, flattened, so a call broken across lines reads as one string.
// Chains are found by scanning forward from `.from(` to the end of the
// statement, which is the next `\n` at the same or lower nesting depth.
function* writeCalls(src, file) {
  const clean = stripComments(src)
  const re = /\.from\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  let m
  while ((m = re.exec(clean))) {
    // Take the rest of the statement: forward to the first newline that is not
    // inside brackets, which is where the chain ends in this codebase's style.
    let i = m.index + m[0].length
    let depth = 0
    for (; i < clean.length; i++) {
      const c = clean[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
      else if (c === '\n' && depth === 0) {
        // A newline only ends the statement if the chain does not continue on
        // the next line. Without this the scanner stopped at `.from('stores')`
        // and never saw the `.update(` under it — the exact formatting the
        // longer writes in this codebase use, so the gate would have been blind
        // to precisely the calls most worth checking.
        const rest = clean.slice(i + 1)
        if (!/^\s*\./.test(rest)) break
      }
    }
    const chain = clean.slice(m.index, i).replace(/\s+/g, ' ')
    const verb = WRITES.find((v) => chain.includes(`.${v}(`))
    if (!verb) continue
    const line = clean.slice(0, m.index).split('\n').length
    yield { file, line, table: m[1], verb, chain }
  }
}

// A write is accounted for when the statement it belongs to captures `error`,
// or is handed to something that will. Deliberately generous: the aim is to
// catch the write nobody looked at, not to dictate how the error is handled.
const HANDLED = [
  /\{[^}]*\berror\b/,          // const { error } = await ... / { data, error }
  /\.throwOnError\(/,          // supabase-js's own opt-in
  /\breturn\s+(await\s+)?sb\b/, // handed back to a caller that checks
]

function check() {
  const findings = []
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = fs.readFileSync(file, 'utf8')
      const clean = stripComments(src)
      const lines = clean.split('\n')
      for (const w of writeCalls(src, file)) {
        // The statement as written, including the assignment that precedes
        // `.from(` on the same line (that is where `const { error } =` lives).
        const stmt = (lines[w.line - 1] || '') + ' ' + w.chain
        if (HANDLED.some((re) => re.test(stmt))) continue
        findings.push(w)
      }
    }
  }
  return findings
}

// ── Self-test: the gate must be seen to fail ────────────────────────────────
if (process.argv.includes('--self-test')) {
  const cases = [
    ['an unchecked update is caught',
     `await sb.from('stores').update({ settings: next }).eq('id', id)`, true],
    ['an unchecked insert is caught',
     `await sb.from('parts').insert(row)`, true],
    ['an unchecked delete is caught',
     `await sb.from('parts').delete().eq('id', id)`, true],
    ['a checked update passes',
     `const { error } = await sb.from('stores').update({ a: 1 }).eq('id', id)`, false],
    ['a destructured data+error passes',
     `const { data, error } = await sb.from('stores').update({ a: 1 }).select('id')`, false],
    ['throwOnError passes',
     `await sb.from('parts').insert(row).throwOnError()`, false],
    ['a plain READ is not this gate\'s business',
     `const { data } = await sb.from('parts').select('*').eq('id', id)`, false],
    ['a write split across lines is still seen',
     `await sb.from('stores')\n  .update({ settings: next })\n  .eq('id', id)`, true],
    ['a commented-out write is not a finding',
     `// await sb.from('stores').update({ a: 1 })`, false],
    ['a write inside a block comment is not a finding',
     `/*\n await sb.from('stores').update({ a: 1 })\n*/`, false],
  ]
  let ok = 0, bad = 0
  for (const [name, code, shouldFlag] of cases) {
    const hits = [...writeCalls(code, 'self-test')]
      .filter((w) => {
        const stmt = (stripComments(code).split('\n')[w.line - 1] || '') + ' ' + w.chain
        return !HANDLED.some((re) => re.test(stmt))
      })
    const flagged = hits.length > 0
    if (flagged === shouldFlag) { ok++; console.log(`  ✓ ${name}`) }
    else { bad++; console.log(`  ✗ ${name} — ${flagged ? 'flagged' : 'missed'}, expected the opposite`) }
  }
  console.log(`\nself-test: ${ok} passed, ${bad} failed\n`)
  process.exit(bad ? 1 : 0)
}

// ── The ratchet ─────────────────────────────────────────────────────────────
// 83 of these were already in the tree when the gate was written. Failing on
// all of them would have made the gate red from birth, and a gate that is red
// from birth is a gate everyone learns to skip. So the known ones are recorded
// and the gate fails only on a NEW one — the count can go down freely, never up.
//
// Keyed by file + table + verb rather than by line, so moving code around does
// not fire it; adding a write does. Work the backlog down by editing the
// baseline number, never by adding to it.
const BASELINE_PATH = path.join(import.meta.dirname, 'check-writes-baseline.json')
const keyOf = (f) => `${f.file.replace(/\\/g, '/')}::${f.table}::${f.verb}`

const findings = check()

if (process.argv.includes('--update-baseline')) {
  const counts = {}
  for (const f of findings) counts[keyOf(f)] = (counts[keyOf(f)] || 0) + 1
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({
    _comment: 'Supabase writes whose error is not read, known as of the date below. Numbers may go DOWN as they are fixed; a number going UP fails the gate. Regenerate only after deliberately accepting a new one: node scripts/check-writes.mjs --update-baseline',
    recorded: new Date().toISOString().slice(0, 10),
    counts,
  }, null, 2) + '\n')
  console.log(`baseline written — ${findings.length} known site(s) across ${Object.keys(counts).length} file/table/verb combinations`)
  process.exit(0)
}

const baseline = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).counts
  : {}

const now = {}
for (const f of findings) now[keyOf(f)] = (now[keyOf(f)] || 0) + 1

const added = findings.filter((f) => (now[keyOf(f)] || 0) > (baseline[keyOf(f)] || 0))
const fixed = Object.keys(baseline).reduce((n, k) => n + Math.max(0, baseline[k] - (now[k] || 0)), 0)

if (!added.length) {
  const total = findings.length
  console.log(total
    ? `write check clean — no new unchecked writes (${total} known, ${fixed ? `${fixed} fixed since the baseline` : 'backlog unchanged'})`
    : 'write check clean — every supabase write reads its error')
  process.exit(0)
}

console.log(`\n${added.length} NEW supabase write(s) whose error is never read.\n`)
console.log('supabase-js does not throw: these report success whether they wrote,')
console.log('were refused by RLS (204, no error, no rows), or never reached the DB.\n')
for (const f of added) {
  console.log(`  ${f.file}:${f.line}  ${f.verb} on "${f.table}"`)
  console.log(`      ${f.chain.slice(0, 120)}`)
}
console.log('\nCapture the error — `const { error } = await ...` — and for an update or')
console.log('delete add .select() so a row filtered out by RLS is not read as a save.')
console.log('For a read-modify-write on stores.settings use updateStoreSettings.\n')
process.exit(1)
