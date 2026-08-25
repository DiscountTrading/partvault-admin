// Cross-app drift guard.
//
// partvault-admin and partvault-mobile are separate repos with separate builds,
// but they share one signed-in user: the Supabase session lives in a chunked
// cookie on .partvault.app so a sign-in on either app covers both. That only
// works while BOTH copies of the cookie code agree — same key, same chunk size,
// same domain rule. If one drifts, the symptom is not a build error; it is
// customers being silently logged out of one app, or an OTP loop when Supabase
// refuses a second code inside 60 seconds.
//
// Passkeys have the same property: one credential is meant to cover both
// subdomains, so lib/passkeys.js must be byte-identical.
//
// Merging the repos would be the other answer, but it is a much bigger change
// than the problem warrants — a test that fails loudly is enough.
//
//   node scripts/check-drift.mjs
//   node scripts/check-drift.mjs --self-test
import fs from 'node:fs'
import path from 'node:path'

const ADMIN = path.resolve('src/lib')
const MOBILE = path.resolve('..', 'partvault-mobile', 'src', 'lib')

if (!fs.existsSync(MOBILE)) {
  console.log(`skipped — the field app is not checked out beside this repo (${MOBILE})`)
  process.exit(0)
}

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')

// Comments and blank lines are allowed to differ (each app describes itself);
// the executable content is not.
const code = (src) => src
  .split('\n')
  .map(l => l.replace(/\/\/.*$/, '').trimEnd())
  .filter(l => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

// Lines that must match exactly, wherever they appear. These are the ones that
// decide whether the two apps see the same session.
const COOKIE_CRITICAL = [
  "const AUTH_KEY = 'pv-auth'",
  'const CHUNK = 3000',
  'const MAX_CHUNKS = 12',
  'const YEAR = 60 * 60 * 24 * 365',
  "return (h === 'partvault.app' || h.endsWith('.partvault.app')) ? '.partvault.app' : null",
]

const failures = []

function checkIdentical(file) {
  const a = code(read(ADMIN, file))
  const b = code(read(MOBILE, file))
  if (a !== b) {
    const al = a.split('\n'), bl = b.split('\n')
    const first = al.findIndex((l, i) => l !== bl[i])
    failures.push(`${file}: copies differ (first at line ~${first + 1})\n      admin : ${al[first] ?? '(missing)'}\n      mobile: ${bl[first] ?? '(missing)'}`)
  }
}

function checkCookieCritical(srcA, srcB) {
  for (const needle of COOKIE_CRITICAL) {
    const inA = srcA.includes(needle), inB = srcB.includes(needle)
    if (!inA || !inB) {
      failures.push(`supabase.js: "${needle.slice(0, 60)}" ${!inA ? 'MISSING in admin' : ''}${!inA && !inB ? ' and ' : ''}${!inB ? 'MISSING in mobile' : ''}`)
    }
  }
}

if (process.argv.includes('--self-test')) {
  const a = read(ADMIN, 'supabase.js')
  const b = a.replace("const AUTH_KEY = 'pv-auth'", "const AUTH_KEY = 'pv-auth-2'")
  const before = failures.length
  checkCookieCritical(a, b)
  if (failures.length === before) {
    console.error('SELF-TEST FAILED: a changed AUTH_KEY was not detected.')
    process.exit(1)
  }
  console.log('self-test passed — a drifted AUTH_KEY is detected')
  process.exit(0)
}

checkIdentical('passkeys.js')
checkCookieCritical(read(ADMIN, 'supabase.js'), read(MOBILE, 'supabase.js'))

if (failures.length) {
  console.error('cross-app drift detected:\n')
  failures.forEach(f => console.error('  - ' + f))
  console.error('\nBoth apps share one session cookie and one passkey. Fix the divergence rather than silencing this.')
  process.exit(1)
}
console.log('drift check clean — passkeys.js identical, cookie mechanics agree')
