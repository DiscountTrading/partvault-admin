import { createClient } from '@supabase/supabase-js'

// Isolated Supabase client for the superadmin/ops console. persistSession:false
// keeps its auth IN MEMORY ONLY — it does NOT read or write the admin app's
// stored session, so the ops console can't be entered via an existing admin
// login and always requires a fresh sign-in. Closing the tab ends the session.
const SUPABASE_URL = 'https://mtpektsxaklhedknincs.supabase.co'
const SUPABASE_KEY = 'sb_publishable_STtCN1zWydiIFtgHR1Yn5g_n9YBH102'

export const sbOps = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  }
})
