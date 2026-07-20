import { useState, useLayoutEffect, useEffect, useRef, useCallback } from 'react'

// Fit-to-screen: scale a block so its natural content always fits the remaining
// viewport height — so a "single-screen" view (the Dashboard) fits ANY screen
// size without scrolling, from a small laptop to a 4K monitor.
//
// Robustness notes (this must behave for every subscriber's pixel dimensions):
//  - We only ever scale DOWN (maxScale 1). Scaling up would make the content
//    wider than its container and force a horizontal scrollbar; not worth it.
//  - The natural height is measured at the container's real width (content stays
//    width:100%), so scale does NOT feed back into the measured height — no
//    oscillation, converges in one pass.
//  - `transform` doesn't change layout, so `offsetHeight` is the true unscaled
//    height regardless of the scale currently applied.
//  - Re-measures every render (cheap; only re-renders when the value actually
//    changes) and on resize, so it self-corrects when late data (e.g. the aged
//    stock chart) changes the content height.
//
// Usage: attach `wrapRef`+`wrapStyle` to an outer div and `contentRef`+
// `contentStyle` to an inner div that holds the real content.
export default function useFitScale({ minScale = 0.5, bottomMargin = 20 } = {}) {
  const wrapRef = useRef(null)
  const contentRef = useRef(null)
  const [dims, setDims] = useState({ scale: 1, h: 0 })

  const measure = useCallback(() => {
    const wrap = wrapRef.current, content = contentRef.current
    if (!wrap || !content) return
    const top = wrap.getBoundingClientRect().top
    const avail = window.innerHeight - top - bottomMargin
    const natural = content.offsetHeight
    if (!natural || avail <= 0) return
    const s = Math.max(minScale, Math.min(1, avail / natural))
    setDims(prev => (Math.abs(prev.scale - s) < 0.004 && prev.h === natural) ? prev : { scale: s, h: natural })
  }, [minScale, bottomMargin])

  useLayoutEffect(() => { measure() })
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  const wrapStyle = { height: dims.h ? Math.round(dims.h * dims.scale) : undefined, overflow: 'hidden' }
  const contentStyle = { transform: `scale(${dims.scale})`, transformOrigin: 'top center', width: '100%' }
  return { wrapRef, contentRef, wrapStyle, contentStyle, scale: dims.scale }
}
