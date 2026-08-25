// Static gate for the Deno edge functions.
//
// Why this exists: `supabase functions deploy` uploads source to a REMOTE
// bundler. Nothing on the way there type-checks or scope-checks the code, and a
// failed deploy keeps serving the previous build with a 200. So an undefined
// identifier introduced by a refactor lands as a runtime ReferenceError on live
// customer traffic — which is exactly how two defects already shipped:
//   * `json` was declared ~430 lines inside handleRequest but called near its
//     top (temporal dead zone), so purge_scan returned HTTP 500 every night from
//     pg_cron and the store-retention alert was never sent;
//   * `carRows` was declared inside `if (!carless)` and read outside it, so
//     seed_sample_data threw AFTER inserting every sample row.
// Both are the same class, and both are invisible to `supabase functions deploy`.
//
// tsc has no Deno lib, so `Deno`, remote URL imports and .ts specifiers all
// report as errors here; those are filtered. What is NOT filtered is
// TS2304/TS2552 "Cannot find name" — the class this gate exists to catch.
//
//   node scripts/check-edge.mjs             # exit 1 on any undefined identifier
//   node scripts/check-edge.mjs --self-test # prove the gate can still fail
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TARGETS = [
  'supabase/functions/ebay-import/index.ts',
  'supabase/functions/ai-assess/index.ts',
  'supabase/functions/auth-passkey/index.ts',
]

const TSC = [
  '-y', '-p', 'typescript@5', 'tsc', '--noEmit', '--skipLibCheck', '--allowJs',
  '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
]

// spawnSync WITH a shell, and OS-native paths. Both matter on Windows: npx is
// npx.cmd, which execFileSync cannot spawn (it fails ENOENT, the catch swallows
// it, and the gate then reports CLEAN for any input at all); and a /tmp/... path
// reaches tsc as "file not found", which looks equally clean. The self-test
// below exists because both of those really happened while writing this.
function undefinedNames(files) {
  const cmd = ['npx', ...TSC, ...files.map(p => JSON.stringify(p))].join(' ')
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  if (/error TS6053|Cannot find module 'typescript'/.test(out) && !/error TS2304/.test(out)) {
    console.error('gate could not run tsc — treating as a failure, not a pass:')
    console.error(out.split('\n').slice(0, 5).join('\n'))
    process.exit(2)
  }
  return out
    .split('\n')
    .filter(l => /error TS2304|error TS2552/.test(l))
    .filter(l => !/Cannot find name 'Deno'/.test(l))
    .map(l => l.trim())
}

if (process.argv.includes('--self-test')) {
  const dir = mkdtempSync(join(tmpdir(), 'pv-edge-'))
  const probe = join(dir, 'probe.ts')
  writeFileSync(probe, readFileSync(TARGETS[0], 'utf8') + '\nconst probe = notARealIdentifier + 1\nexport default probe\n')
  const hits = undefinedNames([probe])
  if (!hits.some(h => h.includes('notARealIdentifier'))) {
    console.error('SELF-TEST FAILED: the gate did not catch a deliberately undefined identifier.')
    console.error('Do not trust a clean run until this passes.')
    process.exit(1)
  }
  console.log('self-test passed — the gate catches an undefined identifier')
  process.exit(0)
}

const hits = undefinedNames(TARGETS)
if (hits.length) {
  console.error(`${hits.length} undefined identifier(s) in the edge functions:\n`)
  hits.forEach(h => console.error('  ' + h))
  process.exit(1)
}
console.log(`edge check clean — ${TARGETS.length} functions, no undefined identifiers`)
