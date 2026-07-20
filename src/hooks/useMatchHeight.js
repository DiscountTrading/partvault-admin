import { useState, useLayoutEffect, useRef } from 'react'

// Tracks the live pixel height of an element (via ResizeObserver). Use it to make
// one column exactly as tall as another — e.g. the Sales sales-table column
// matching the height of the graphs column beside it, so both end together.
export default function useMatchHeight() {
  const ref = useRef(null)
  const [height, setHeight] = useState(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setHeight(prev => { const n = el.offsetHeight; return prev === n ? prev : n })
    update()
    let ro
    try { ro = new ResizeObserver(update); ro.observe(el) } catch { /* older browsers: one-shot */ }
    window.addEventListener('resize', update)
    return () => { try { ro && ro.disconnect() } catch { /* ignore */ } window.removeEventListener('resize', update) }
  }, [])
  return [ref, height]
}
