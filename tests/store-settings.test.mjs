// ═══════════════════════════════════════════════════════════════════════════
//  updateStoreSettings — the helper that stops a save from erasing a store.
//
//  Every setting the app has lives in one JSONB column, so every save is a
//  read-modify-write. Eleven places did it by hand, and none of them read the
//  error off either half. The failure this suite exists for:
//
//    the SELECT fails -> `current?.settings || {}` is {} -> the UPDATE writes
//    ONE KEY as the entire settings object -> the store's marketplace, listing
//    defaults, AI models, labels, postage tiers and footer are gone -> the UI
//    shows "Saved ✓".
//
//  Plus its quieter twin: an RLS-filtered UPDATE returns 204 with no error and
//  no rows, so a save that was refused outright also showed "Saved ✓".
//
//  Run: node tests/store-settings.test.mjs
// ═══════════════════════════════════════════════════════════════════════════

// The helper takes its Supabase client as an argument precisely so this file
// can exist: src/lib/supabase.js touches window and document at module load.
// This fake returns exactly what supabase-js returns — { data, error }, never a
// throw — and records what it was asked to do.
import { updateStoreSettings, readStoreSettings } from '../src/lib/storeSettings.js'

let handlers = {}
let calls = []
const __setHandlers = (h) => { handlers = h; calls = [] }
const __calls = () => calls
const sb = {
  from() {
    const q = {
      _payload: null, _selected: null,
      select(cols) { q._selected = cols ?? null; return q },
      eq() { return q },
      update(payload) { q._payload = payload; q._write = true; return q },
      single() { calls.push({ kind: 'read' }); return Promise.resolve(handlers.read()) },
      then(res, rej) {
        calls.push({ kind: q._write ? 'write' : 'read', payload: q._payload, selected: q._selected })
        return Promise.resolve(q._write ? handlers.write() : handlers.read()).then(res, rej)
      },
    }
    return q
  },
}

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const deep = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const threw = async (name, fn, match) => {
  try { await fn(); ok(name, false, 'did not throw') }
  catch (e) { ok(name, !match || match.test(String(e.message)), `message was "${e.message}"`) }
}

// A store as it really is: a dozen unrelated settings in one column. Losing any
// of these is the damage the helper exists to prevent.
const FULL = {
  marketplace: 'EBAY_GB',
  timezone: 'Europe/London',
  listingDefaults: { warranty: '3 Months' },
  aiModels: { assess: { provider: 'gemini', model: 'flash' } },
  labels: { widthMm: 50, heightMm: 30 },
  footer: 'Thanks for your business',
  sourcing: 'buyin',
}

console.log('\nThe happy path\n')
{
  __setHandlers({ read: () => ({ data: { settings: FULL }, error: null }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  const next = await updateStoreSettings(sb, 's1', { timezone: 'Australia/Sydney' })
  eq('the patched key changes', next.timezone, 'Australia/Sydney')
  eq('and every other setting survives', next.marketplace, 'EBAY_GB')
  eq('including nested ones', next.listingDefaults?.warranty, '3 Months')
  eq('the write got the merged object, not the patch', __calls().at(-1)?.payload?.settings?.footer, 'Thanks for your business')
  ok('and it asked which row it changed', __calls().at(-1).selected === 'id')
}
{
  __setHandlers({ read: () => ({ data: { settings: FULL }, error: null }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  const next = await updateStoreSettings(sb, 's1', (cur) => ({ footer: `${cur.footer}!` }))
  eq('a function patch sees the settings we actually read', next.footer, 'Thanks for your business!')
  eq('and the rest is still merged', next.marketplace, 'EBAY_GB')
}
{
  __setHandlers({ read: () => ({ data: { settings: null }, error: null }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  const next = await updateStoreSettings(sb, 's1', { timezone: 'UTC' })
  deep('a store with NO settings yet gets just the patch — a real empty, not a failed read', next, { timezone: 'UTC' })
}

console.log('\nThe failure this helper exists for\n')
{
  // Exactly the shape supabase-js returns. Nothing throws; the old code read
  // `data` alone and carried on.
  __setHandlers({ read: () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  await threw('a failed READ throws instead of writing',
    () => updateStoreSettings(sb, 's1', { timezone: 'UTC' }), /nothing was saved/i)
  ok('and NO write was attempted — this is the whole point', !__calls().some(c => c.kind === 'write'))
}
{
  __setHandlers({ read: () => ({ data: null, error: { message: 'permission denied for table stores' } }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  let msg = ''
  try { await updateStoreSettings(sb, 's1', { timezone: 'UTC' }) } catch (e) { msg = e.message }
  ok('the message says what to do', /try again/i.test(msg))
  ok('and carries the cause for the console', /permission denied/.test(msg))
}
{
  // A store id that resolves to no row is not the same as a read error, but it
  // is equally not something to write a fresh settings object over.
  __setHandlers({ read: () => ({ data: null, error: null }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  await threw('a store that no longer exists is not written to',
    () => updateStoreSettings(sb, 's1', { timezone: 'UTC' }), /no longer exists/)
  ok('again with no write', !__calls().some(c => c.kind === 'write'))
}

console.log('\nThe quieter twin: a refused write reported as a save\n')
{
  // An UPDATE filtered out by RLS: 204, no error, no rows. Without .select()
  // this is byte-identical to success.
  __setHandlers({ read: () => ({ data: { settings: FULL }, error: null }), write: () => ({ data: [], error: null }) })
  await threw('an update that changed NO rows is reported as refused, not saved',
    () => updateStoreSettings(sb, 's1', { timezone: 'UTC' }), /refused/)
}
{
  __setHandlers({ read: () => ({ data: { settings: FULL }, error: null }), write: () => ({ data: null, error: { message: 'new row violates row-level security policy' } }) })
  await threw('an errored update throws', () => updateStoreSettings(sb, 's1', { timezone: 'UTC' }), /Save failed/)
}
{
  __setHandlers({ read: () => ({ data: { settings: FULL }, error: null }), write: () => ({ data: [{ id: 's1' }], error: null }) })
  const next = await updateStoreSettings(sb, 's1', { timezone: 'UTC' })
  eq('one changed row is a save', next.timezone, 'UTC')
}

console.log('\nGuards\n')
await threw('no store id is refused before any query', () => updateStoreSettings(sb, '', { a: 1 }), /No store selected/)
await threw('and for the reader too', () => readStoreSettings(sb, null), /No store selected/)

console.log('\nreadStoreSettings — "none" and "could not tell" are different\n')
{
  __setHandlers({ read: () => ({ data: { settings: FULL }, error: null }) })
  eq('returns the settings', (await readStoreSettings(sb, 's1')).marketplace, 'EBAY_GB')
}
{
  __setHandlers({ read: () => ({ data: { settings: null }, error: null }) })
  deep('a store with none gets an empty object', await readStoreSettings(sb, 's1'), {})
}
{
  __setHandlers({ read: () => ({ data: null, error: { message: 'timeout' } }) })
  await threw('but a failed read THROWS rather than looking like an empty one',
    () => readStoreSettings(sb, 's1'), /Could not read/)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
