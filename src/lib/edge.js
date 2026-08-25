// ═══════════════════════════════════════════════════════════════════════════
//  Calling the edge functions.
//
//  The edge functions are deployed --no-verify-jwt (the browser calls some of
//  them before a session exists, e.g. the phone-approve sign-in flow), so the
//  gateway lets every request through and each ACTION has to decide for itself
//  who the caller is. It can only do that if the browser actually SENDS the
//  session — and 23 of the admin app's call sites did not, which is why the
//  server-side membership checks could not be turned on.
//
//  edgeHeaders() is the fix and the rule: every client call to an edge function
//  goes through it. It attaches the session when there is one and stays silent
//  when there isn't, so the genuinely anonymous flows (phone_login_create /
//  _poll on the sign-in screen) keep working unchanged.
// ═══════════════════════════════════════════════════════════════════════════
import { sb } from './supabase'

export async function edgeHeaders(extra = {}) {
  const { data: { session } } = await sb.auth.getSession()
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    ...extra,
  }
}

// Convenience wrapper for the common shape: POST an action, get JSON back, throw
// on the error field the functions use. Call sites with their own response
// handling can keep using fetch + edgeHeaders() directly.
export async function callEdge(url, action, payload = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: await edgeHeaders(),
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.error) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}
