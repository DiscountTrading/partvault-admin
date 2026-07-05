// In-house support messaging. All writes go here (service role) so we control the
// sender and send email notifications. Reads happen client-side via RLS.
//   create    (customer): new thread + first message → emails staff
//   reply     (customer or staff): append message → emails the other side
//   set_status(staff): open/close a thread
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function email(to: string, subject: string, text: string) {
  const key = Deno.env.get('RESEND_API_KEY')
  if (!key || !to) return false
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PartVault Support <noreply@partvault.app>', to: [to], subject, text }),
    })
    return r.ok
  } catch { return false }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const authHeader = req.headers.get('Authorization') || ''
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Not authenticated' }, 401)
  const { data: isAdmin } = await userClient.rpc('is_platform_admin')

  let body: any = {}
  try { body = await req.json() } catch { /* empty */ }
  const { action } = body
  const db = svc()
  // Where staff alerts go (System panel setting → default).
  const { data: sysRow } = await db.from('system_settings').select('settings').eq('id', 1).maybeSingle()
  const staffEmail = sysRow?.settings?.supportEmail || sysRow?.settings?.purgeAlertEmail || 'leap00@gmail.com'

  if (action === 'create') {
    const message = String(body.message || '').trim()
    if (!message) return json({ error: 'Message required' }, 400)
    const subject = String(body.subject || 'Support request').slice(0, 120)
    const { data: thread, error: tErr } = await db.from('support_threads')
      .insert({ user_id: user.id, email: user.email, store_id: body.storeId || null, subject, status: 'open', last_sender: 'customer' })
      .select().single()
    if (tErr) return json({ error: tErr.message }, 500)
    await db.from('support_messages').insert({ thread_id: thread.id, sender: 'customer', body: message })
    await email(staffEmail, `[PartVault Support] ${subject}`, `From: ${user.email}\nStore: ${body.storeId || '—'}\n\n${message}\n\nReply in the ops panel.`)
    return json({ ok: true, threadId: thread.id })
  }

  if (action === 'reply') {
    const message = String(body.message || '').trim()
    const threadId = body.threadId
    if (!message || !threadId) return json({ error: 'threadId and message required' }, 400)
    const { data: thread } = await db.from('support_threads').select('*').eq('id', threadId).maybeSingle()
    if (!thread) return json({ error: 'Thread not found' }, 404)
    const isOwner = thread.user_id === user.id
    if (!isOwner && !isAdmin) return json({ error: 'Not authorised' }, 403)
    const sender = isAdmin && !isOwner ? 'staff' : 'customer'
    await db.from('support_messages').insert({ thread_id: threadId, sender, body: message })
    await db.from('support_threads').update({ status: 'open', last_sender: sender, updated_at: new Date().toISOString() }).eq('id', threadId)
    // Notify the other side.
    if (sender === 'staff') await email(thread.email, `Re: ${thread.subject}`, `${message}\n\n— PartVault Support`)
    else await email(staffEmail, `[PartVault Support] Reply on: ${thread.subject}`, `From: ${user.email}\n\n${message}`)
    return json({ ok: true })
  }

  if (action === 'set_status') {
    if (!isAdmin) return json({ error: 'Not authorised' }, 403)
    if (!['open', 'closed'].includes(body.status)) return json({ error: 'bad status' }, 400)
    await db.from('support_threads').update({ status: body.status, updated_at: new Date().toISOString() }).eq('id', body.threadId)
    return json({ ok: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
