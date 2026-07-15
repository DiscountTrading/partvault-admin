import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://mtpektsxaklhedknincs.supabase.co'
const SUPABASE_KEY = 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'

// ── Shared sign-in across app.partvault.app + admin.partvault.app ───────────
// Supabase defaults to localStorage, which is PER-ORIGIN — so signing in on the
// field app left the admin app logged out, forcing a second OTP (and tripping
// Supabase's 60s "one code per minute" limit). A cookie on the PARENT domain
// (.partvault.app) is visible to both subdomains, so one sign-in covers both.
// Chunked: a Supabase session (JWT + refresh token) can exceed the ~4KB
// per-cookie limit. On localhost the cookie is host-only so dev still works.
const AUTH_KEY = 'pv-auth'                       // MUST match the mobile app
const LEGACY_KEY = 'sb-mtpektsxaklhedknincs-auth-token'
const CHUNK = 3000
const MAX_CHUNKS = 12
const YEAR = 60 * 60 * 24 * 365

const cookieDomain = () => {
  const h = window.location.hostname
  return (h === 'partvault.app' || h.endsWith('.partvault.app')) ? '.partvault.app' : null
}
const writeCookie = (name, value, maxAge) => {
  const p = [`${name}=${value}`, 'path=/', `max-age=${maxAge}`, 'SameSite=Lax']
  const d = cookieDomain()
  if (d) p.push(`domain=${d}`)
  if (window.location.protocol === 'https:') p.push('Secure')
  document.cookie = p.join('; ')
}
const readCookie = (name) => {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'))
  return m ? m[1] : null
}

const cookieStorage = {
  getItem: (key) => {
    if (readCookie(`${key}.0`) === null) return readCookie(key)   // unchunked / legacy
    let out = ''
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const c = readCookie(`${key}.${i}`)
      if (c === null) break
      out += c
    }
    try { return decodeURIComponent(out) } catch { return null }
  },
  setItem: (key, value) => {
    const enc = encodeURIComponent(value)
    cookieStorage.removeItem(key)
    const n = Math.ceil(enc.length / CHUNK)
    for (let i = 0; i < n; i++) writeCookie(`${key}.${i}`, enc.slice(i * CHUNK, (i + 1) * CHUNK), YEAR)
  },
  removeItem: (key) => {
    writeCookie(key, '', 0)
    for (let i = 0; i < MAX_CHUNKS; i++) writeCookie(`${key}.${i}`, '', 0)
  },
}

// One-time migration: adopt an existing localStorage session so nobody is forced
// to sign in again when we move to the shared cookie. Runs before createClient.
try {
  if (!cookieStorage.getItem(AUTH_KEY)) {
    const legacy = window.localStorage.getItem(LEGACY_KEY)
    if (legacy) cookieStorage.setItem(AUTH_KEY, legacy)
  }
} catch { /* private mode / storage blocked — just sign in again */ }

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
    storage: cookieStorage,
    storageKey: AUTH_KEY,
  }
})
