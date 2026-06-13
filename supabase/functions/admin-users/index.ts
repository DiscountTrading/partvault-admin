// Admin user management — invite a person to a store by email.
//
// inviteUserByEmail() creates the auth account (if new) AND emails them a link
// to accept. We then attach a store membership with the chosen permissions.
// The caller must hold the manage_users capability for the target store; this
// is verified with a caller-scoped client BEFORE any service_role action runs.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authHeader = req.headers.get('Authorization') || ''

    const { action, storeId, email, permissions, redirectTo } = await req.json()
    if (!storeId) return json({ error: 'storeId required' }, 400)

    // 1. Authorize the caller (their JWT) — must have manage_users on this store.
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
    const { data: { user: caller } } = await userClient.auth.getUser()
    if (!caller) return json({ error: 'Not signed in' }, 401)
    const { data: allowed, error: pErr } = await userClient.rpc('has_permission', { p_store_id: storeId, p_capability: 'manage_users' })
    if (pErr) throw pErr
    if (!allowed) return json({ error: 'You do not have permission to manage users for this store' }, 403)

    const admin = createClient(url, service)

    if (action === 'invite_member') {
      const cleanEmail = String(email || '').trim().toLowerCase()
      if (!cleanEmail) return json({ error: 'Email is required' }, 400)

      // 2. Create + email the invite. If they already exist, look them up instead.
      let userId: string | null = null
      let emailed = true
      const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(cleanEmail, redirectTo ? { redirectTo } : undefined)
      if (invErr) {
        const { data: list } = await admin.auth.admin.listUsers()
        const existing = list.users.find((u: any) => u.email?.toLowerCase() === cleanEmail)
        if (!existing) throw invErr
        userId = existing.id
        emailed = false // already had an account; no invite email sent
      } else {
        userId = inv.user.id
      }

      // 3. Attach membership with the chosen permissions (don't clobber an existing one).
      const perms = permissions && typeof permissions === 'object' ? permissions : { add_edit: true }
      const { data: inserted, error: mErr } = await admin
        .from('store_members')
        .upsert({ user_id: userId, store_id: storeId, role: 'member', permissions: perms }, { onConflict: 'user_id,store_id', ignoreDuplicates: true })
        .select()
      if (mErr) throw mErr

      // 4. Audit the access grant (only when a new membership was actually created).
      if (inserted && inserted.length > 0) {
        await admin.from('audit_log').insert({
          store_id: storeId, table_name: 'store_members', record_id: userId, action: 'INSERT',
          old_data: null, new_data: { role: 'member', permissions: perms, invited: true },
          changed_by: caller.id,
        })
      }

      return json({ ok: true, userId, emailed, alreadyMember: !inserted || inserted.length === 0 })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 400)
  }
})
