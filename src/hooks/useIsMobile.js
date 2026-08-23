import { useState, useEffect } from 'react'

// True on phone-width screens, so the admin can swap its desktop chrome (a wide
// top nav) for a phone shell (compact header + bottom tab bar). One breakpoint,
// shared by everything that needs to know — don't scatter innerWidth checks.
export const MOBILE_MAX = 640

export default function useIsMobile(max = MOBILE_MAX) {
  const query = `(max-width: ${max}px)`
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = e => setIsMobile(e.matches)
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on)
    setIsMobile(mq.matches)
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on) }
  }, [query])
  return isMobile
}
