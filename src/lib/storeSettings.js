// ═══════════════════════════════════════════════════════════════════════════
//  The ONLY way to change a key in stores.settings.
//
//  Every setting the app has — marketplace, listing defaults, AI models, label
//  config, sourcing mode, footer, postage tiers, warehouse layout, category
//  learning — lives in one JSONB column. So every save is a read-modify-write,
//  and eleven places did it like this:
//
//      const { data: current } = await sb.from('stores').select('settings')...
//      await sb.from('stores').update({ settings: { ...(current?.settings || {}), timezone: tz } })
//
//  Two silent failures stacked on top of each other, both invisible:
//
//  1. supabase-js does not throw. If that SELECT fails — a blip, a revoked
//     grant, a timeout — `current` is null, `current?.settings || {}` is `{}`,
//     and the UPDATE writes ONE KEY AS THE ENTIRE SETTINGS OBJECT. The store's
//     whole configuration is gone, replaced by `{ timezone: "..." }`.
//  2. The UPDATE's own error was not read either, and an RLS-filtered update
//     returns 204 with NO error and zero rows. So a save that was refused
//     outright still lit "Saved ✓".
//
//  A default is safe to render with and never to write from. This helper
//  refuses to write when it could not read, and confirms the row it claims to
//  have changed. It throws on every failure so the caller's catch can say so —
//  a save that did not happen must never look like one that did.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read stores.settings, merge `patch` over it, write it back, and confirm the
 * write landed. Shallow merge: to change one key inside a nested object, build
 * that whole object in `patch` (the callers already do).
 *
 * `patch` may be a function `(current) => patchObject` when the new value
 * depends on the old one. That keeps it to a single read, and — the point —
 * the function only ever runs on settings we actually read, never on a `{}`
 * standing in for a failed one.
 *
 * The Supabase client is passed in rather than imported: src/lib/supabase.js
 * reaches for window and document at module load, so importing it would make
 * this file untestable outside a browser — and this is the file that most needs
 * a test.
 *
 * @param {object} sb  the Supabase client
 * @param {string} storeId
 * @param {object|((current: object) => object)} patch
 * @returns {Promise<object>} the settings as now stored
 * @throws if the store cannot be read, the write fails, or no row changed
 */
export async function updateStoreSettings(sb, storeId, patch) {
  if (!storeId) throw new Error('No store selected.')

  const { data: current, error: readErr } = await sb
    .from('stores').select('settings').eq('id', storeId).single()

  // The whole point. Without this the line below writes `patch` alone.
  if (readErr) {
    throw new Error(`Could not read this store's current settings, so nothing was saved (${readErr.message}). Try again in a moment.`)
  }
  if (!current) {
    throw new Error('This store no longer exists, so nothing was saved.')
  }

  const settings = current.settings || {}
  const next = { ...settings, ...(typeof patch === 'function' ? patch(settings) : patch) }

  // .select() is not decoration: an update filtered out by RLS comes back 204
  // with no error and no rows, which is indistinguishable from success unless
  // the changed row is asked for by name.
  const { data: written, error: writeErr } = await sb
    .from('stores').update({ settings: next }).eq('id', storeId).select('id')

  if (writeErr) throw new Error(`Save failed: ${writeErr.message}`)
  if (!written?.length) {
    throw new Error('That save was refused — you may no longer have permission to change this store. Nothing was changed.')
  }
  return next
}

/**
 * Read stores.settings on its own. Returns `{}` when the store has none, and
 * THROWS when the read failed — the caller must not be able to confuse "no
 * settings" with "could not tell".
 *
 * Use this when a value is needed to compute the next one; for rendering, a
 * plain read with a default is fine.
 */
export async function readStoreSettings(sb, storeId) {
  if (!storeId) throw new Error('No store selected.')
  const { data, error } = await sb.from('stores').select('settings').eq('id', storeId).single()
  if (error) throw new Error(`Could not read this store's settings (${error.message}).`)
  return data?.settings || {}
}
