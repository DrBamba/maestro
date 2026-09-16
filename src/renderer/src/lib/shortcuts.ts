import { useEffect, useRef } from 'react'
import { matchShortcut, type Chord, type Shortcut } from '@shared/shortcuts'

/**
 * One place the whole window's chords arrive, from either of the two ways they can.
 *
 * Keys pressed anywhere in the window reach the document. Keys pressed inside the editor pane do
 * not — it is a separate process — so main intercepts the ones it must and forwards them here. Both
 * end up as the same {@link Shortcut}, which is why nothing downstream has to know which way a
 * chord came in.
 *
 * Handlers are asked in turn until one claims the chord. The two that exist own disjoint axes: the
 * shell takes sessions, the focused session takes its own tabs and panes.
 */

const mac = window.maestro.platform === 'mac'

export { mac }

type Handler = (shortcut: Shortcut) => boolean

const handlers = new Set<Handler>()

function dispatch(shortcut: Shortcut): boolean {
  for (const handler of handlers) if (handler(shortcut)) return true
  return false
}

/**
 * Whether the keyboard is in something being typed into.
 *
 * xterm's own textarea is not: it is how a terminal receives keys at all, and every chord here is
 * meant to work while an agent has the focus. A real field is different — ⌘⇧← selects to the start
 * of a line there, and taking that would break editing a session name to move a pane.
 */
function inTextField(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (el.classList.contains('xterm-helper-textarea')) return false
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

document.addEventListener('keydown', (e) => {
  const shortcut = matchShortcut(
    { key: e.key, code: e.code, shift: e.shiftKey, meta: e.metaKey, control: e.ctrlKey },
    mac
  )
  if (!shortcut) return
  if (inTextField() && (shortcut.kind === 'pane-move' || shortcut.kind === 'tab-step')) return
  // A chord in the table is ours whether or not anything acts on it — ⌘] with one tab open is still
  // not something the terminal underneath should see.
  e.preventDefault()
  dispatch(shortcut)
})

// Forwarded from the editor pane, where the renderer never sees the keydown.
window.maestro.onShortcut((chord: Chord) => {
  const shortcut = matchShortcut(chord, mac)
  if (shortcut) dispatch(shortcut)
})

/** Handles the chords this component owns; return true for the ones it acted on. */
export function useShortcuts(handler: Handler): void {
  const latest = useRef(handler)
  latest.current = handler

  useEffect(() => {
    // Registered once and read through a ref, so a handler closing over fresh state does not
    // resubscribe on every render — and a chord pressed between renders is never dropped.
    const stable: Handler = (shortcut) => latest.current(shortcut)
    handlers.add(stable)
    return () => {
      handlers.delete(stable)
    }
  }, [])
}
