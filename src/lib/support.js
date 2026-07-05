// Support helpers. Take the Supabase client so they work on BOTH the admin
// session (sb) and the isolated ops-console session (sbOps).
import { sb as defaultClient } from './supabase'

const FN = 'https://mtpektsxaklhedknincs.supabase.co/functions/v1/support'

async function call(client, body) {
  const { data: { session } } = await client.auth.getSession()
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok || d.error) throw new Error(d.error || 'Support request failed')
  return d
}

export const createTicket = (client, subject, message, storeId) => call(client, { action: 'create', subject, message, storeId })
export const replyTicket  = (client, threadId, message) => call(client, { action: 'reply', threadId, message })
export const setTicketStatus = (client, threadId, status) => call(client, { action: 'set_status', threadId, status })

export async function myThreads(client = defaultClient) {
  const { data } = await client.from('support_threads').select('*').order('updated_at', { ascending: false })
  return data || []
}
export async function threadMessages(client, threadId) {
  const { data } = await client.from('support_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true })
  return data || []
}
