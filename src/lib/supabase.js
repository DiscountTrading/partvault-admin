import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://mtpektsxaklhedknincs.supabase.co'
const SUPABASE_KEY = 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'implicit',
  }
})
