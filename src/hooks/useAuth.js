import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

export function useAuth() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [storeId, setStoreId] = useState(null)
  const [authReady, setAuthReady] = useState(false)

  const loadProfile = async () => {
    const { data, error } = await sb.rpc('get_my_profile')
    if (!error && data?.length > 0) {
      const r = data[0]
      setProfile({ user_id: r.user_id, store_id: r.store_id, role: r.role, name: r.name, email: r.email, store: { name: r.store_name, join_code: r.join_code } })
      setStoreId(r.store_id)
    }
    setAuthReady(true)
  }

  useEffect(() => {
    const timeout = setTimeout(() => setAuthReady(true), 5000)
    sb.auth.getSession().then(({ data: { session } }) => {
      clearTimeout(timeout)
      setSession(session)
      if (session) loadProfile()
      else setAuthReady(true)
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') {
        setSession(s)
        setAuthReady(true)
        return
      }
      setSession(s)
      if (s) loadProfile()
      else { setProfile(null); setStoreId(null); setAuthReady(true) }
    })
    return () => subscription.unsubscribe()
  }, [])

  const signOut = () => sb.auth.signOut()

  return { session, profile, storeId, authReady, signOut }
}
