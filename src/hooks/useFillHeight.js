import { useState, useLayoutEffect, useEffect, useRef, useCallback } from 'react'

// Sizes a scroll container to fill from its own top down to the bottom of the
// viewport (minus a small margin). Attach the returned ref to the element and
// use the returned height as its maxHeight. The net effect: everything ABOVE the
// element (page nav, search/filter bars, column-switcher) stays fixed on screen,
// the element's sticky header stays put, and its horizontal + vertical
// scrollbars sit at the viewport edge — so only the table body scrolls, and the
// horizontal scrollbar is always visible without scrolling the page.
//
// Recomputes after every render (cheap — only setState when the value actually
// changes) and on window resize, so it self-corrects when banners/filters above
// it appear, disappear, or wrap to a new line.
export default function useFillHeight(bottomMargin = 24, minHeight = 240) {
  const ref = useRef(null)
  const [height, setHeight] = useState(null)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const next = Math.max(minHeight, Math.round(window.innerHeight - top - bottomMargin))
    setHeight(prev => (prev === next ? prev : next))
  }, [bottomMargin, minHeight])

  // Every render: re-measure (converges because setHeight is a no-op when equal).
  useLayoutEffect(() => { measure() })

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  return [ref, height]
}
