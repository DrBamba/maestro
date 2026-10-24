import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { THEMES, type ThemeName } from '@shared/theme'
import { terminalTheme } from '../theme'
import { matchShortcut, reachesTerminal } from '@shared/shortcuts'
import { mac } from '../lib/shortcuts'
import type { PtyAttach } from '../../../preload/index'

/** The theme's dim grey as a 24-bit SGR sequence, for the lines the terminal writes itself. */
function dim(theme: ThemeName): string {
  const hex = THEMES[theme].ansi.brightBlack
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
  return `\x1b[38;2;${r};${g};${b}m`
}

/** The theme's mono stack, with the macOS-only head as the fallback if the token is ever dropped. */
function monoStack(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return value || 'ui-monospace, SFMono-Regular, Menlo, monospace'
}

/** Hands the terminal back to the DOM renderer. Never throws: it runs inside React cleanups. */
function dropWebgl(ref: React.MutableRefObject<WebglAddon | null>): void {
  try {
    ref.current?.dispose()
  } catch {
    // Already disposed by a context-loss handler.
  }
  ref.current = null
}

export interface TerminalViewProps {
  /** The resolved ground to draw on. Changing it recolours a terminal that is already running. */
  theme: ThemeName
  /**
   * Creates the PTY once the terminal has been measured — or hands back the one this tab already had,
   * with the output it printed while no window was showing it.
   */
  spawn: (cols: number, rows: number) => Promise<PtyAttach | null>
  /**
   * Starts, and restarts, the process. 0 means do not start — the parent is showing a launcher
   * instead. Bumping it spawns again into the same terminal, keeping earlier scrollback.
   */
  startToken: number
  /** Hidden terminals stay mounted so their scrollback survives tab and session switches. */
  hidden: boolean
  /**
   * Whether this terminal may take the keyboard: false while something is layered over it, and
   * false for a pane that is on screen beside the one the user is actually in.
   */
  autoFocus?: boolean
  /**
   * Bumped whenever the session hands the keyboard somewhere, so a terminal that is already visible
   * and already the focused one takes focus again. Rearranging the panes is the case that needs it:
   * the tab that carried the drag is a new element afterwards, and focus fell on nothing.
   */
  focusToken?: number
  /** `tail` is the process's trailing output, so callers can act on why it exited. */
  onExit?: (exitCode: number, tail: string) => void
  onSpawned?: (ptyId: string) => void
}

export default function TerminalView({
  theme,
  spawn,
  startToken,
  hidden,
  autoFocus = true,
  focusToken = 0,
  onExit,
  onSpawned
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  // The last process, even once it has exited: the host keeps a finished one's output until told.
  const lastIdRef = useRef<string | null>(null)
  // Keystrokes typed before the PTY exists would otherwise be dropped.
  const pendingRef = useRef<string[]>([])
  const exitRef = useRef(onExit)
  const spawnedRef = useRef(onSpawned)
  const spawnRef = useRef(spawn)
  const disposedRef = useRef(false)
  const exitedRef = useRef<(exitCode: number, tail: string) => void>(() => {})
  // Read by the mount effect, which must not re-run for a colour change.
  const themeRef = useRef(theme)

  exitRef.current = onExit
  spawnedRef.current = onSpawned
  spawnRef.current = spawn
  themeRef.current = theme

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const exited = (exitCode: number, tail: string): void => {
      // Our own line rather than the process's, so it is dimmed to whichever ground it lands on —
      // a fixed grey chosen for near-black is unreadable once the terminal is paper.
      term.write(`\r\n${dim(themeRef.current)}— process exited (${exitCode}) —\x1b[0m\r\n`)
      ptyIdRef.current = null
      pendingRef.current = []
      exitRef.current?.(exitCode, tail)
    }
    exitedRef.current = exited

    const term = new Terminal({
      allowProposedApi: true,
      // Read from the theme rather than repeated here, so the terminal and the rest of the UI
      // cannot drift — the stack has to name a font that exists on each platform, and keeping two
      // copies of that list is how one of them ends up missing the Linux names.
      fontFamily: monoStack(),
      fontSize: 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 20000,
      theme: terminalTheme(themeRef.current),
      macOptionIsMeta: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    // The window's chords go past the terminal to the window's own listener.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const shortcut = matchShortcut(
        { key: e.key, code: e.code, shift: e.shiftKey, meta: e.metaKey, control: e.ctrlKey },
        mac
      )
      return !(shortcut && reachesTerminal(shortcut))
    })

    termRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      const id = ptyIdRef.current
      if (id) window.maestro.pty.write(id, data)
      else pendingRef.current.push(data)
    })

    term.onResize(({ cols, rows }) => {
      const id = ptyIdRef.current
      if (id) window.maestro.pty.resize(id, cols, rows)
    })

    const offData = window.maestro.pty.onData(({ id, data }) => {
      if (id === ptyIdRef.current) term.write(data)
    })
    const offExit = window.maestro.pty.onExit(({ id, exitCode, tail }) => {
      if (id === ptyIdRef.current) exited(exitCode, tail)
    })

    const observer = new ResizeObserver(() => {
      if (host.offsetParent === null) return
      try {
        fit.fit()
      } catch {
        // Zero-sized while hidden.
      }
    })
    observer.observe(host)

    disposedRef.current = false

    return () => {
      disposedRef.current = true
      observer.disconnect()
      offData()
      offExit()
      const id = ptyIdRef.current ?? lastIdRef.current
      if (id) window.maestro.pty.kill(id)

      /*
       * Release the GPU context before the terminal, and never let teardown throw.
       *
       * Reproduced: with a WebGL addon loaded, `term.dispose()` alone throws
       * "Cannot read properties of undefined (reading '_isDisposed')" — deterministically. Thrown
       * from a React cleanup function it escapes into the commit phase, which unmounts the whole
       * tree and leaves a blank window.
       *
       * It stayed hidden because terminals are deliberately kept mounted and hidden so their
       * scrollback survives tab and session switches, so a TerminalView unmounts only when its
       * session is removed from the list. Nothing removed sessions until archive and delete
       * existed, so this was effectively dead code until then.
       */
      dropWebgl(webglRef)
      try {
        term.dispose()
      } catch (err) {
        console.error('[terminal] dispose failed', err)
      }
      termRef.current = null
      fitRef.current = null
      ptyIdRef.current = null
    }
    // Mount-only: the terminal instance must outlive prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * Recolour in place. Terminals are kept mounted for the life of their session — that is what
   * makes scrollback survive a tab switch — so a theme change has to reach the ones already open
   * rather than waiting for a remount that will not come. Assigning the whole theme object is how
   * xterm is told: it repaints every cell already on screen, including the scrollback above.
   */
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = terminalTheme(theme)
  }, [theme])

  /*
   * WebGL is the fast path (PLAN.md §7), but only for a terminal on screen. Chromium keeps about
   * sixteen contexts and silently drops the oldest beyond that. A reload mounts every open session's
   * terminals at once, the active session's first, so its Claude was the one dropped and went black.
   * A hidden terminal draws with xterm's DOM renderer, which costs nothing while nothing is shown.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term || hidden) return
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => dropWebgl(webglRef))
      term.loadAddon(webgl)
      webglRef.current = webgl
    } catch {
      // No WebGL context available — the DOM renderer carries on.
    }
    return () => dropWebgl(webglRef)
  }, [hidden])

  /**
   * Start, or restart, the process. Runs whenever the parent bumps startToken, so a launcher or a
   * post-exit "restart" lands in this same terminal rather than a fresh one.
   */
  useEffect(() => {
    if (startToken === 0) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    // A previous process may still be attached if the parent restarts without an exit.
    const previous = ptyIdRef.current ?? lastIdRef.current
    if (previous) {
      window.maestro.pty.kill(previous)
      ptyIdRef.current = null
      lastIdRef.current = null
    }

    let cancelled = false
    const id = requestAnimationFrame(() => {
      if (cancelled || disposedRef.current) return
      try {
        fit.fit()
      } catch {
        // Not laid out yet; the ResizeObserver will catch up.
      }
      void spawnRef.current(term.cols, term.rows).then((handle) => {
        if (cancelled || disposedRef.current || !handle) return
        if (handle.replay) term.write(handle.replay)
        ptyIdRef.current = handle.id
        lastIdRef.current = handle.id
        spawnedRef.current?.(handle.id)
        if (handle.exit) return exitedRef.current(handle.exit.exitCode, handle.exit.tail)
        for (const chunk of pendingRef.current) window.maestro.pty.write(handle.id, chunk)
        pendingRef.current = []
        window.maestro.pty.resize(handle.id, term.cols, term.rows)
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [startToken])

  /*
   * Becoming visible after being display:none — remeasure, then take focus so the agent can be
   * typed to immediately rather than after a click into the terminal.
   *
   * Two frames, not one: the pane's display changes in the same commit that flips `hidden`, so a
   * single frame can still measure a zero-sized element — which both mis-fits the terminal and
   * loses the focus call. Re-runs on startToken too, so a relaunched agent is typeable at once.
   */
  useEffect(() => {
    if (hidden) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
        } catch {
          // Still settling.
        }
        if (autoFocus) termRef.current?.focus()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [hidden, startToken, autoFocus, focusToken])

  return <div className="term" ref={hostRef} style={{ display: hidden ? 'none' : 'block' }} />
}
