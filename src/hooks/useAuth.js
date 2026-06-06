import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

const ACTIVE_KEY = 'pv_active_store'

export function useAuth() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [stores, setStores] = useState([])
  const [activeStoreId, setActiveStoreId] = useState(null)
  const [authReady, setAuthReady] = useState(false)

  const loadProfileAndStores = async () => {
    // Profile (name / email / home store / role)
    const { data: prof, error: profErr } = await sb.rpc('get_my_profile')
    if (!profErr && prof?.length > 0) {
      const r = prof[0]
      setProfile({ user_id: r.user_id, store_id: r.store_id, role: r.role, name: r.name, email: r.email, store: { name: r.store_name, join_code: r.join_code } })
    }
    // All stores this user can access (drives the switcher)
    const { data: storeRows } = await sb.rpc('get_my_stores')
    const list = storeRows || []
    setStores(list)
    // Pick the active store: last-used (if still valid) -> default -> first
    const saved = localStorage.getItem(ACTIVE_KEY)
    const chosen =
      (list.find(s => s.store_id === saved) || list.find(s => s.is_default) || list[0])?.store_id || null
    setActiveStoreId(chosen)
    if (chosen) localStorage.setItem(ACTIVE_KEY, chosen)
    setAuthReady(true)
  }

  const setActiveStore = (id) => {
    if (!stores.some(s => s.store_id === id)) return
    setActiveStoreId(id)
    localStorage.setItem(ACTIVE_KEY, id)
  }

  // Reload the store list (after creating/joining a store). Optionally switch to one.
  const refreshStores = async (switchTo) => {
    const { data } = await sb.rpc('get_my_stores')
    const list = data || []
    setStores(list)
    if (switchTo && list.some(s => s.store_id === switchTo)) {
      setActiveStoreId(switchTo)
      localStorage.setItem(ACTIVE_KEY, switchTo)
    }
    return list
  }

  useEffect(() => {
    const timeout = setTimeout(() => setAuthReady(true), 5000)
    sb.auth.getSession().then(({ data: { session } }) => {
      clearTimeout(timeout)
      setSession(session)
      if (session) loadProfileAndStores()
      else setAuthReady(true)
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') {
        setSession(s)
        setAuthReady(true)
        return
      }
      setSession(s)
      if (s) loadProfileAndStores()
      else { setProfile(null); setStores([]); setActiveStoreId(null); setAuthReady(true) }
    })
    return () => subscription.unsubscribe()
  }, [])

  const signOut = () => sb.auth.signOut()

  return { session, profile, storeId: activeStoreId, stores, activeStoreId, setActiveStore, refreshStores, authReady, signOut }
}
