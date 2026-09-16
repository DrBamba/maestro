/**
 * The keyboard, in one table both processes read.
 *
 * Main needs the same answers as the renderer. The editor pane is a `<webview>` — a separate
 * process — so a chord pressed inside VS Code never reaches the window's own keydown listener, and
 * the few that have to work from there are intercepted in main and forwarded. Which ones those are
 * is decided by {@link reachesEditor}, next to the table it has to agree with.
 *
 * Only the command modifier is used. The terminals run with Option as meta, so Option belongs to
 * the shell and to Claude, and Control belongs to readline — a chord built on either would be taken
 * out of the agent's hands.
 */

export interface Chord {
  /** Layout-dependent — matched on only for letters, where it is the character the user pressed. */
  key: string
  /** The physical key. Brackets, digits and arrows are matched on this: `key` reports `{` for ⇧[. */
  code: string
  shift: boolean
  meta: boolean
  control: boolean
}

export type Shortcut =
  | { kind: 'palette' }
  | { kind: 'new-session' }
  /** Previous or next session in the sidebar, wrapping at the ends. */
  | { kind: 'session-step'; delta: 1 | -1 }
  /** A session by position. -1 is the last one, whatever the count. */
  | { kind: 'session-at'; index: number }
  /** The next session with something for the user, so the queue can be walked without reading it. */
  | { kind: 'session-attention' }
  /** Previous or next tab in the focused pane, wrapping. */
  | { kind: 'tab-step'; delta: 1 | -1 }
  | { kind: 'pane-move'; toward: 'left' | 'right' | 'up' | 'down' }

const ARROWS: Record<string, 'left' | 'right' | 'up' | 'down'> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/**
 * Which command a chord is, or null for one we do not claim.
 *
 * Shift widens the jump: brackets alone move within the session, and with shift they move between
 * sessions.
 */
export function matchShortcut(chord: Chord, mac: boolean): Shortcut | null {
  // The command modifier, which is the only platform difference here.
  if (!(mac ? chord.meta : chord.control)) return null
  const letter = chord.key.toLowerCase()

  if (!chord.shift && letter === 'k') return { kind: 'palette' }
  if (!chord.shift && letter === 'n') return { kind: 'new-session' }
  if (chord.shift && letter === 'a') return { kind: 'session-attention' }

  // Brackets are ⌘'s alone: Ctrl+[ is how a terminal receives Escape, so off macOS there is nothing
  // here worth taking it from. A keymap for those platforms has to choose its own pair.
  if (mac && (chord.code === 'BracketLeft' || chord.code === 'BracketRight')) {
    const delta = chord.code === 'BracketLeft' ? -1 : 1
    return chord.shift ? { kind: 'session-step', delta } : { kind: 'tab-step', delta }
  }

  const digit = /^Digit([1-9])$/.exec(chord.code)
  // ⌘9 is the last session rather than the ninth, so it stays useful past nine of them.
  if (digit && !chord.shift) {
    const place = Number(digit[1])
    return { kind: 'session-at', index: place === 9 ? -1 : place - 1 }
  }

  if (chord.shift && ARROWS[chord.code]) return { kind: 'pane-move', toward: ARROWS[chord.code] }

  return null
}

/**
 * Whether a chord is taken from the embedded editor rather than left to it.
 *
 * Session jumps and tab steps are: they are the ways out of a pane that fills the window, and a
 * chord that works everywhere except the editor strands the keyboard in it. ⌘[ and ⌘] cost VS Code
 * its indent and outdent, which Tab and ⇧Tab still do.
 *
 * Pane moves and ⌘K stay VS Code's. ⌘⇧← selecting to the start of a line is too much of editing to
 * take, ⌘K is the prefix of every workbench chord, and another pane is a click away.
 */
export function reachesEditor(shortcut: Shortcut): boolean {
  return (
    shortcut.kind === 'tab-step' ||
    shortcut.kind === 'session-step' ||
    shortcut.kind === 'session-at' ||
    shortcut.kind === 'session-attention'
  )
}

/** How a chord is written on screen, for the palette's hints. */
export function chordHint(shortcut: Shortcut, mac: boolean): string {
  const cmd = mac ? '⌘' : 'Ctrl+'
  const shift = mac ? '⇧' : 'Shift+'
  switch (shortcut.kind) {
    case 'palette':
      return `${cmd}K`
    case 'new-session':
      return `${cmd}N`
    case 'session-attention':
      return `${cmd}${shift}A`
    case 'session-step':
      return `${cmd}${shift}${shortcut.delta === -1 ? '[' : ']'}`
    case 'session-at':
      return `${cmd}${shortcut.index === -1 ? 9 : shortcut.index + 1}`
    case 'tab-step':
      return `${cmd}${shortcut.delta === -1 ? '[' : ']'}`
    case 'pane-move':
      return `${cmd}${shift}${{ left: '←', right: '→', up: '↑', down: '↓' }[shortcut.toward]}`
  }
}
