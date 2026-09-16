import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Tooltips for anything carrying `data-tip`, with `data-tip-hint` as a second, dimmer line.
 *
 * The browser's own `title` was doing this, and its delay is close to a second and not settable —
 * long enough that the text it carries reads as nothing happening. It is also fragile in exactly
 * the place it is needed: a session row grows its action buttons on hover, which moves the name
 * out from under the cursor and drops the pending tooltip, so only the active row — already
 * showing its buttons — ever answered.
 *
 * One listener at the document, rather than handlers per element: the call site is an attribute,
 * so anything whose text is clipped can opt in without wiring, and there is one timer to reason
 * about no matter how many rows are on screen.
 */

/** Long enough that sweeping the mouse down the list stays quiet, short enough to feel like a hover. */
const DELAY_MS = 200

interface Placed {
  text: string
  hint: string | null
  left: number
  top?: number
  bottom?: number
}

/**
 * Whether this element has anything to add. Repeating a name the row is already showing in full is
 * noise — but a tip that carries more than the element does, a hint line or a longer form of the
 * same text, is worth showing whether or not the text is clipped.
 */
function saysMore(el: Element, text: string, hint: string | null): boolean {
  if (hint) return true
  if (el.textContent?.trim() !== text) return true
  return el.scrollWidth > el.clientWidth
}

export default function Tooltip(): React.JSX.Element | null {
  const [tip, setTip] = useState<Placed | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const anchor = useRef<Element | null>(null)

  useEffect(() => {
    const cancel = (): void => {
      clearTimeout(timer.current)
      anchor.current = null
      setTip(null)
    }

    const over = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target.closest('[data-tip]') : null
      if (target === anchor.current) return
      cancel()
      const text = target?.getAttribute('data-tip')?.trim()
      if (!target || !text) return
      const hint = target.getAttribute('data-tip-hint')?.trim() || null
      if (!saysMore(target, text, hint)) return
      anchor.current = target
      timer.current = setTimeout(() => {
        const r = target.getBoundingClientRect()
        // Below the element normally, above it near the bottom edge — anchoring to the far side
        // means the tip never needs measuring to know it will fit.
        setTip({
          text,
          hint,
          left: r.left,
          ...(r.bottom + 140 > window.innerHeight
            ? { bottom: window.innerHeight - r.top + 6 }
            : { top: r.bottom + 6 })
        })
      }, DELAY_MS)
    }

    /*
     * Anything that moves the anchor or takes the user's attention elsewhere takes the tip with it.
     * Scroll is captured because the sidebar's own box is what usually moves, and a scroll there
     * never reaches the document by bubbling — leaving the tip pointing at whatever slid under it.
     */
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerdown', cancel)
    document.addEventListener('keydown', cancel)
    document.addEventListener('scroll', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', cancel)
      document.removeEventListener('keydown', cancel)
      document.removeEventListener('scroll', cancel, true)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  // Nudged back inside the window once its width is known — a long name anchored near the right
  // edge would otherwise be clipped by the very thing the tip is there to escape.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !tip) return
    const max = window.innerWidth - el.offsetWidth - 8
    if (tip.left > max) el.style.left = `${Math.max(8, max)}px`
  }, [tip])

  if (!tip) return null
  const { text, hint, ...position } = tip
  return (
    <div className="tooltip" ref={box} style={position} role="tooltip">
      {text}
      {hint && <span className="tooltip__hint">{hint}</span>}
    </div>
  )
}
