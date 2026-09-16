import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeLaunch, GitStatus, Preferences, Repo, Session } from '@shared/types'
import { isLocal } from '@shared/types'
import type { ThemeName } from '@shared/theme'
import TerminalView from './TerminalView'
import EditorPane, { type EditorHandle } from './EditorPane'
import ClaudeLauncher from './ClaudeLauncher'
import TabBoard, { type BoardTab } from './TabBoard'
import {
  activateTab,
  activeTabs,
  groupOf,
  groupsOf,
  insertTab,
  isArranged,
  makeGroup,
  removeTab,
  tabGroupIds,
  type LayoutNode
} from '../lib/layout'
import { aheadBehind, filesChanged, homeRelative } from '../lib/format'

/**
 * A tab in the board. Claude and Editor are permanent; script tabs appear when a setup or run
 * script is started, so its output — and its failure — stays visible.
 *
 * There is deliberately no changes / git panel: the embedded VS Code already carries both in its
 * own sidebar. Consoles are plain shells rather than a panel.
 *
 * Any of them can be dragged into a pane of its own, so Claude beside the editor, or a console
 * under both, is an arrangement the user makes rather than one the app has to offer.
 */
interface ScriptTab {
  key: string
  label: string
  spawn: (cols: number, rows: number) => Promise<{ id: string } | null>
}

/**
 * A shell in the session's own directory. There can be several — one holding a dev server, one for
 * git, one to poke around in — or none, and each keeps the name it is given.
 */
interface ConsoleTab {
  key: string
  label: string
  /** Bumped to start the shell, and again to restart it after it exits. 0 means never opened. */
  token: number
  running: boolean
}

/** "Console", then "Console 2" — the lowest number free, so closing one hands its name back. */
function freeConsoleLabel(taken: ConsoleTab[]): string {
  const names = new Set(taken.map((t) => t.label))
  for (let n = 1; ; n++) {
    const label = n === 1 ? 'Console' : `Console ${n}`
    if (!names.has(label)) return label
  }
}

interface SessionViewProps {
  session: Session
  /** Null for a local session — a folder with no repo behind it, so no git, setup or run scripts. */
  repo: Repo | null
  active: boolean
  home: string
  /**
   * This session may already have a conversation — it predates this app launch, or it was just
   * restored from the archive — so it continues rather than starting fresh. Main has the last word:
   * a directory with no transcripts starts a new conversation whatever this says.
   */
  resume: boolean
  /** Passed through to the launcher, which offers the auto-mode setting where Claude is started. */
  preferences: Preferences
  /**
   * Forwarded to the two panes that cannot read a CSS token: xterm draws into a canvas of its own,
   * and the embedded workbench is a separate program that has to be reloaded to change colour.
   */
  theme: ThemeName
  onPreferences: (patch: Partial<Preferences>) => void
  onNotice: (message: string) => void
  onClaudePty: (sessionId: string, ptyId: string) => void
  onEditorHandle: (sessionId: string, handle: EditorHandle | null) => void
  onStatus: (sessionId: string, status: GitStatus | null) => void
}

const STATUS_POLL_MS = 4000

export default function SessionView({
  session,
  repo,
  active,
  home,
  resume,
  preferences,
  theme,
  onPreferences,
  onNotice,
  onClaudePty,
  onEditorHandle,
  onStatus
}: SessionViewProps): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [scriptTabs, setScriptTabs] = useState<ScriptTab[]>([])
  const [runningScripts, setRunningScripts] = useState<string[]>([])

  const editorRef = useRef<EditorHandle | null>(null)

  // ── the board ─────────────────────────────────────────────────────────────
  /**
   * Where the panes are, and which tab the keyboard belongs to. Both start as they did before any
   * of this was arrangeable: one pane holding every tab, with Claude in front of it.
   */
  const [layout, setLayout] = useState<LayoutNode>(() =>
    makeGroup(['claude', 'editor', 'console-1'], 'claude')
  )
  const [focusKey, setFocusKey] = useState('claude')
  /**
   * Counts the times the keyboard has been handed somewhere. The panes watch it as well as their own
   * focused flag, because a tab dragged into another pane is a new element by the time the drag ends
   * — the flag it was already carrying never changes, and focus would be left on nothing.
   */
  const [focusToken, setFocusToken] = useState(0)

  // Both are read by callbacks that outlive the render they were made in.
  const layoutRef = useRef(layout)
  const focusRef = useRef(focusKey)
  layoutRef.current = layout

  /**
   * `moved` is for a tab that was just dragged: it may already have been the focused one, in which
   * case nothing a pane watches would have changed — and the element the press was on is gone, so
   * the keyboard has to be handed back deliberately. A plain click never needs it, and bumping the
   * token there would pull focus out of a field being typed into in the same tab.
   */
  const focus = useCallback((key: string, moved = false) => {
    focusRef.current = key
    setFocusKey(key)
    if (moved) setFocusToken((token) => token + 1)
  }, [])

  /** Shows a tab, opening it in the pane the keyboard is in if it is not on the board yet. */
  const openTab = useCallback(
    (key: string, groupId?: string) => {
      const current = layoutRef.current
      if (groupOf(current, key)) {
        setLayout(activateTab(current, key))
      } else {
        const target = groupId ?? groupOf(current, focusRef.current)?.id ?? groupsOf(current)[0]?.id
        if (target) setLayout(insertTab(current, key, target))
      }
      focus(key)
    },
    [focus]
  )

  /**
   * Takes a tab off the board, dropping its pane if it was the last one in it.
   *
   * The pane lands on the tab beside the one that went, so a row of consoles can be cleared without
   * being thrown back to Claude each time. `prefer` overrides that where the neighbour is the wrong
   * answer: closing the last console in a pane should not open a whole workbench just because the
   * Editor tab happened to be next to it.
   */
  const closeTab = useCallback(
    (key: string, prefer?: string) => {
      const current = layoutRef.current
      const held = groupOf(current, key)
      const shed = removeTab(current, key)
      const next =
        prefer && prefer !== key && held?.tabs.includes(prefer) ? activateTab(shed, prefer) : shed
      setLayout(next)
      if (focusRef.current !== key) return
      const landed = held ? groupsOf(next).find((group) => group.id === held.id) : undefined
      focus(landed?.active ?? groupsOf(next)[0]?.active ?? 'claude')
    },
    [focus]
  )

  /*
   * What each pane is asked, once per render.
   *
   * A tab is on screen when it is the front one of its pane; it holds the keyboard only when its
   * pane is also the focused one. Without that second test every pane in an arrangement would grab
   * focus as it appeared and the last one drawn would win — so typing would land in whichever
   * terminal happened to render last rather than in the one just clicked.
   */
  const groupIds = tabGroupIds(layout)
  const onScreen = activeTabs(layout)
  const focusedGroupId = groupIds.get(focusKey) ?? null
  const hidden = (key: string): boolean => !onScreen.has(key) || !active
  const holdsFocus = (key: string): boolean =>
    onScreen.has(key) && groupIds.get(key) === focusedGroupId
  // A stable dependency for the effects below: a Set is a new object on every render.
  const shownKeys = [...onScreen].sort().join(' ')

  // ── setup script ──────────────────────────────────────────────────────────
  /** Whether this view has a setup script of its own to speak of — see {@link setupLabel}. */
  const [setupRan, setSetupRan] = useState(false)

  /*
   * Whether anything that needs a built worktree still has to wait — Claude's opening turn, and any
   * run script asked for meanwhile.
   *
   * A script that said `# maestro: background` holds nothing: it was written for the work a worktree
   * does not depend on, and making the first turn wait on a cache warm is the cost that directive
   * exists to avoid.
   */
  const setupHolds =
    (session.setupState === 'pending' || session.setupState === 'running') &&
    !session.setupBackground

  /**
   * Runs the worktree's setup script in a tab of its own, and shows it.
   *
   * A fresh key each time, so it can be run more than once: the script is written in this worktree,
   * and trying it where it was written is most of the point — a tab that could only ever open once
   * would mean cutting a session to find out whether the script works.
   */
  const openSetupTab = useCallback(() => {
    setSetupRan(true)
    const key = `setup-${Date.now()}`
    setScriptTabs((tabs) => [
      ...tabs,
      {
        key,
        label: 'setup',
        spawn: (cols, rows) => window.maestro.pty.setup(session.id, cols, rows)
      }
    ])
    openTab(key)
  }, [session.id, openTab])

  /*
   * `pending` is main's word for "this worktree carries a `.maestro/setup.sh` it has not run yet", so
   * the tab opens on that alone — main read the tree when it cut the worktree, and asking the
   * filesystem again from here would only be a second, slower opinion.
   *
   * A background script still gets its tab and still lands on it. What the directive releases is
   * everything waiting on the script, not the output: a five-minute install nobody can see is worse
   * than one in a tab they can switch away from.
   */
  const setupStarted = useRef(false)
  useEffect(() => {
    if (setupStarted.current) return
    if (session.setupState !== 'pending') return
    setupStarted.current = true
    openSetupTab()
  }, [session.setupState, openSetupTab])

  // ── git polling ───────────────────────────────────────────────────────────
  // Still needed without the panels: the header shows branch state, and the merge and PR
  // dialogs read it.
  const refresh = useCallback(async () => {
    const next = await window.maestro.git.status(session.id)
    setStatus(next)
    onStatus(session.id, next)
  }, [session.id, onStatus])

  const local = isLocal(session)

  useEffect(() => {
    // A local session has no branch to be ahead of and no base to diff against; polling git in
    // whatever directory it happens to point at would only produce noise.
    if (!active || local) return
    void refresh()
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [active, local, refresh])

  // ── editor ────────────────────────────────────────────────────────────────
  const attachEditor = useCallback(
    (handle: EditorHandle | null) => {
      editorRef.current = handle
      onEditorHandle(session.id, handle)
    },
    [onEditorHandle, session.id]
  )

  /**
   * Opens this repo's setup script in the session's own editor, writing it from a template first if
   * the branch does not carry one yet.
   *
   * The editor rather than an external one: its workspace is this worktree, so the repo is in the
   * file tree beside the script — which is what makes writing one bearable, since a setup script is
   * mostly a transcription of what the repo already says about itself.
   *
   * And this worktree rather than the primary clone, because the file is a normal repo file: written
   * here it goes onto a branch, through a commit and a merge, and from then on arrives with every
   * clone of the repo — which is the only version of this feature that helps somebody who has just
   * cloned it for the first time.
   */
  const editSetupScript = useCallback(async () => {
    const result = await window.maestro.sessions.setupScript(session.id)
    if (!result.path) return onNotice(result.error ?? 'Could not write the setup script.')
    openTab('editor')
    editorRef.current?.openFile(result.path)
    if (result.created) onNotice('Wrote .maestro/setup.sh — commit it and every clone gets it')
  }, [session.id, onNotice, openTab])

  /*
   * Asked for by hand, so the worktree is checked first. `setupState` cannot answer this one: `ok` is
   * both "the script ran" and "there was never a script", and running the second would open a tab on
   * a process that exits immediately with nothing to show for itself.
   */
  const runSetupScript = useCallback(async () => {
    if (await window.maestro.sessions.hasSetupScript(session.id)) return openSetupTab()
    onNotice('No setup script here — “Edit setup script” writes one')
  }, [session.id, onNotice, openSetupTab])

  useEffect(() => {
    if (!active) return
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId: string; action: 'edit' | 'run' }>).detail
      if (detail.sessionId !== session.id) return
      if (detail.action === 'edit') void editSetupScript()
      else void runSetupScript()
    }
    window.addEventListener('maestro:setup-script', handler)
    return () => window.removeEventListener('maestro:setup-script', handler)
  }, [active, session.id, editSetupScript, runSetupScript])

  // ── consoles ──────────────────────────────────────────────────────────────
  /**
   * The first console's shell starts the first time its tab is opened rather than at mount: every
   * session holds one, and a shell nobody has looked at is a process for nothing. The ones added
   * afterwards were asked for, so they start straight away.
   */
  const [consoles, setConsoles] = useState<ConsoleTab[]>([
    { key: 'console-1', label: 'Console', token: 0, running: false }
  ])
  // Keys are never reused, even when a name is: a new console must not land in a dead one's pane.
  const consoleKeys = useRef(1)
  const [renaming, setRenaming] = useState<string | null>(null)
  // Escape has to leave the field without the blur it causes writing the name anyway.
  const abandonRename = useRef(false)

  const openConsole = useCallback(
    (key: string) => {
      openTab(key)
      // Reopening a shell that has exited starts another, in the scrollback the last one left.
      setConsoles((tabs) =>
        tabs.map((t) => (t.key === key && !t.running ? { ...t, token: t.token + 1, running: true } : t))
      )
    },
    [openTab]
  )

  /*
   * A console starts its shell the first time its tab reaches the screen, however it got there —
   * clicked, or dragged into a pane of its own. Only a shell that has never run: one that has
   * exited waits to be reopened rather than restarting itself under the user.
   */
  useEffect(() => {
    setConsoles((tabs) => {
      if (!tabs.some((t) => t.token === 0 && onScreen.has(t.key))) return tabs
      return tabs.map((t) => (t.token === 0 && onScreen.has(t.key) ? { ...t, token: 1, running: true } : t))
    })
    // onScreen is a fresh Set every render; shownKeys is the same fact as a string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKeys])

  /** Opens in the pane whose + was pressed, so every pane can grow its own row of shells. */
  const addConsole = useCallback(
    (groupId?: string) => {
      consoleKeys.current += 1
      const key = `console-${consoleKeys.current}`
      setConsoles((tabs) => [...tabs, { key, label: freeConsoleLabel(tabs), token: 1, running: true }])
      openTab(key, groupId)
    },
    [openTab]
  )

  // Unmounting the terminal kills the shell it holds, so closing the tab is closing the shell.
  const closeConsole = useCallback(
    (key: string) => {
      // Another console in the same pane is the natural landing; with none left it is Claude, not
      // whichever tab happens to sit beside it.
      const pane = groupOf(layoutRef.current, key)
      const beside = consoles.some((t) => t.key !== key && pane?.tabs.includes(t.key))
      setConsoles((tabs) => tabs.filter((t) => t.key !== key))
      closeTab(key, beside ? undefined : 'claude')
    },
    [closeTab, consoles]
  )

  const renameConsole = useCallback((key: string, value: string) => {
    const label = value.trim()
    if (label) setConsoles((tabs) => tabs.map((t) => (t.key === key ? { ...t, label } : t)))
    setRenaming(null)
  }, [])

  // ── scripts ───────────────────────────────────────────────────────────────
  const runScript = useCallback(
    (scriptId: string) => {
      const script = repo?.runScripts.find((s) => s.id === scriptId)
      if (!script) return
      const key = `script-${scriptId}-${Date.now()}`
      setScriptTabs((tabs) => [
        ...tabs,
        {
          key,
          label: script.name,
          spawn: (cols, rows) => window.maestro.pty.script(session.id, scriptId, cols, rows)
        }
      ])
      openTab(key)
      setRunningScripts((names) => [...new Set([...names, script.name])])
    },
    [repo?.runScripts, session.id, openTab]
  )

  /*
   * `npm run dev` in a worktree whose dependencies are not installed fails on its first line, so a
   * run script asked for while setup is going is started when setup ends instead.
   *
   * Queued rather than refused: the answer to "run this" is not "ask again later". Setup failing
   * releases the queue too — the script will probably fail as well, and its output is how the user
   * finds out, which beats a request that silently evaporated.
   */
  const [queued, setQueued] = useState<string[]>([])

  const requestScript = useCallback(
    (scriptId: string) => {
      const script = repo?.runScripts.find((s) => s.id === scriptId)
      if (!script) return
      if (setupHolds) {
        setQueued((ids) => (ids.includes(scriptId) ? ids : [...ids, scriptId]))
        onNotice(`${script.name} starts when setup finishes`)
        return
      }
      runScript(scriptId)
      onNotice(`${script.name} started — output in a terminal tab`)
    },
    [repo?.runScripts, setupHolds, runScript, onNotice]
  )

  useEffect(() => {
    if (setupHolds || queued.length === 0) return
    setQueued([])
    for (const id of queued) runScript(id)
  }, [setupHolds, queued, runScript])

  useEffect(() => {
    if (!active) return
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ sessionId: string; scriptId: string }>).detail
      if (detail.sessionId === session.id) requestScript(detail.scriptId)
    }
    window.addEventListener('maestro:run-script', handler)
    return () => window.removeEventListener('maestro:run-script', handler)
  }, [active, requestScript, session.id])

  const closeScriptTab = useCallback(
    (key: string) => {
      setScriptTabs((tabs) => tabs.filter((t) => t.key !== key))
      closeTab(key, 'claude')
    },
    [closeTab]
  )

  /**
   * A worktree Maestro created is brand new and has no conversation history, so Claude starts
   * immediately. Any other worktree might, so the launcher opens first and the user picks —
   * guessing wrong there means silently starting a fresh chat over work they wanted back.
   *
   * A session that was interrupted mid-task also stops here rather than auto-resuming, so the
   * interruption is stated instead of being something the user has to notice from cut-off output.
   */
  const wasInterrupted = session.interruptedAt !== undefined
  const askFirst = !session.worktreeOwned || wasInterrupted

  /*
   * A session created with a first message starts Claude *working*, so it must not start before the
   * worktree is workable: with a setup script pending, dependencies are not installed yet and the
   * opening turn would run commands against a half-built tree. Setup failing still releases the
   * hold — a Claude that can see the failed setup tab is more use than no Claude at all.
   *
   * A session created without one is deliberately not held. Nothing runs until the user types, and
   * they are sitting in front of the setup tab while they do — so the hold would buy nothing and
   * cost them the prompt they opened the session to write in.
   */
  const heldForSetup = useRef(!askFirst && session.initialPrompt !== undefined && setupHolds)

  const [launch, setLaunch] = useState<ClaudeLaunch | null>(
    askFirst || heldForSetup.current ? null : { mode: resume ? 'continue' : 'new' }
  )
  const [startToken, setStartToken] = useState(askFirst || heldForSetup.current ? 0 : 1)
  const [claudeExit, setClaudeExit] = useState<number | null>(null)
  const [showLauncher, setShowLauncher] = useState(askFirst)

  const startClaude = useCallback((next: ClaudeLaunch) => {
    setLaunch(next)
    setClaudeExit(null)
    setShowLauncher(false)
    setStartToken((token) => token + 1)
  }, [])

  // Release the setup hold as soon as the script is done, either way.
  useEffect(() => {
    if (!heldForSetup.current || setupHolds) return
    heldForSetup.current = false
    startClaude({ mode: resume ? 'continue' : 'new' })
  }, [setupHolds, resume, startClaude])

  /**
   * Claude declines to resume a conversation that is already running elsewhere — including as a
   * background agent — and says so on stdout, naming --fork-session as the way around it.
   *
   * That message is a far better signal than guessing liveness from timestamps, which is what the
   * launcher's "live" flag does and what missed this case. Rather than dead-ending on the error,
   * retry the same conversation as a fork.
   */
  const handleClaudeExit = useCallback(
    (code: number, tail: string) => {
      const alreadyRunning =
        /currently running as a background agent|--fork-session to branch off|is already in use/i.test(
          tail
        )
      if (code !== 0 && alreadyRunning && launch?.mode === 'resume' && !launch.fork) {
        onNotice('That conversation is still running elsewhere — opened a fork of it instead.')
        startClaude({ ...launch, fork: true })
        return
      }
      setClaudeExit(code)
      setShowLauncher(true)
    },
    [launch, onNotice, startClaude]
  )

  const claudeSpawn = useCallback(
    (cols: number, rows: number) =>
      window.maestro.pty.claude(session.id, cols, rows, launch ?? { mode: 'new' }),
    [session.id, launch]
  )

  /*
   * Only for a session that has setup to speak of: one this view ran it for, or one restored with a
   * failure still on the record. A session whose repo has no script is `ok` from birth and would
   * otherwise wear a "setup ✓" for a script that never existed.
   */
  const setupLabel = useMemo(() => {
    if (session.setupState === 'running') return 'setup running'
    if (session.setupState === 'failed') return 'setup failed'
    if (!setupRan) return null
    if (session.setupState === 'ok') return 'setup ✓'
    return 'setup pending'
  }, [setupRan, session.setupState])

  const restoreLayout = useCallback(() => {
    const order = [
      'claude',
      'editor',
      ...consoles.map((shell) => shell.key),
      ...scriptTabs.map((script) => script.key)
    ]
    const fresh = makeGroup(order, focusRef.current)
    setLayout(fresh)
    focus(fresh.active)
  }, [consoles, scriptTabs, focus])

  const boardTabs: BoardTab[] = [
    {
      key: 'claude',
      label: 'Claude',
      icon: 'ph ph-terminal-window',
      tip: 'Drag to split',
      onActivate: () => openTab('claude'),
      pane: (
        <>
          <TerminalView
            theme={theme}
            spawn={claudeSpawn}
            startToken={startToken}
            hidden={hidden('claude')}
            // The launcher sits over this pane; it owns focus while it is up.
            autoFocus={holdsFocus('claude') && !showLauncher}
            focusToken={focusToken}
            onSpawned={(id) => onClaudePty(session.id, id)}
            onExit={handleClaudeExit}
          />
          {showLauncher && (
            <ClaudeLauncher
              sessionId={session.id}
              exitCode={claudeExit}
              interruptedAt={session.interruptedAt}
              place={local ? 'folder' : 'worktree'}
              autoMode={preferences.permissionMode === 'auto'}
              onAutoMode={(on) => onPreferences({ permissionMode: on ? 'auto' : undefined })}
              onLaunch={startClaude}
            />
          )}
        </>
      )
    },
    {
      key: 'editor',
      label: 'Editor',
      icon: 'ph ph-code',
      tip: 'Drag to split',
      onActivate: () => openTab('editor'),
      pane: (
        <EditorPane
          ref={attachEditor}
          sessionId={session.id}
          worktreePath={session.worktreePath}
          hidden={hidden('editor')}
          autoFocus={holdsFocus('editor')}
          focusToken={focusToken}
          theme={theme}
          onNotice={onNotice}
        />
      )
    },
    ...consoles.map((shell) => ({
      key: shell.key,
      icon: 'ph ph-terminal',
      editing: renaming === shell.key,
      tip: renaming === shell.key ? undefined : 'Drag to split · double-click to rename',
      label:
        renaming === shell.key ? (
          <input
            className="tab__rename"
            aria-label="Console name"
            autoFocus
            defaultValue={shell.label}
            onKeyDown={(e) => {
              if (e.key === 'Escape') abandonRename.current = true
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
            }}
            onBlur={(e) => {
              if (!abandonRename.current) renameConsole(shell.key, e.target.value)
              else setRenaming(null)
              abandonRename.current = false
            }}
          />
        ) : (
          shell.label
        ),
      onActivate: () => openConsole(shell.key),
      onDoubleClick: () => setRenaming(shell.key),
      onClose: () => closeConsole(shell.key),
      pane: (
        <TerminalView
          theme={theme}
          spawn={(cols, rows) => window.maestro.pty.shell(session.id, shell.label, cols, rows)}
          startToken={shell.token}
          hidden={hidden(shell.key)}
          autoFocus={holdsFocus(shell.key)}
          focusToken={focusToken}
          onExit={() =>
            setConsoles((tabs) =>
              tabs.map((t) => (t.key === shell.key ? { ...t, running: false } : t))
            )
          }
        />
      )
    })),
    ...scriptTabs.map((script) => ({
      key: script.key,
      label: script.label,
      tip: 'Drag to split',
      onActivate: () => openTab(script.key),
      onClose: () => closeScriptTab(script.key),
      pane: (
        <TerminalView
          theme={theme}
          spawn={script.spawn}
          startToken={1}
          hidden={hidden(script.key)}
          autoFocus={holdsFocus(script.key)}
          focusToken={focusToken}
        />
      )
    }))
  ]

  return (
    <main className="session" style={{ display: active ? 'flex' : 'none' }}>
      <header className="session__header">
        <div className="session__title-wrap">
          <div className="session__title" data-tip={session.name}>
            {session.name}
          </div>
          <div className="session__meta">
            {local ? (
              <span className="session__meta-item" data-tip={session.worktreePath}>
                <i className="ph ph-folder" />
                {homeRelative(session.worktreePath, home)}
              </span>
            ) : (
              <span className="session__meta-item" data-tip={session.branch}>
                <i className="ph ph-git-branch" />
                {session.branch}
              </span>
            )}
            {status && (
              <span style={{ whiteSpace: 'nowrap' }}>{aheadBehind(status.ahead, status.behind)}</span>
            )}
            {status && (
              <span style={{ whiteSpace: 'nowrap' }}>{filesChanged(status.files.length)}</span>
            )}
          </div>
        </div>
        {/* Appears once there is something to undo — an arrangement is its own invitation. */}
        {isArranged(layout) && (
          <button
            className="icon-btn"
            title="Restore default layout"
            aria-label="Restore default layout"
            onClick={restoreLayout}
          >
            <i className="ph ph-layout" style={{ fontSize: 15 }} />
          </button>
        )}
        {/* A local session has no repo, so there is no repo-wide setup script to write. */}
        {!local && (
          <button
            className="icon-btn"
            title="Setup script — runs in every new worktree"
            aria-label="Setup script"
            onClick={() => void editSetupScript()}
          >
            <i className="ph ph-file-code" style={{ fontSize: 15 }} />
          </button>
        )}
        <button
          className="icon-btn"
          title="Open in VS Code"
          aria-label="Open in VS Code"
          onClick={() => {
            void window.maestro.editor.openExternal(session.worktreePath)
            onNotice(local ? 'Opening folder in VS Code…' : 'Opening worktree in VS Code…')
          }}
        >
          <i className="ph ph-arrow-square-out" style={{ fontSize: 15 }} />
        </button>
      </header>

      <div className="session__body">
        <TabBoard
          tabs={boardTabs}
          layout={layout}
          onLayout={setLayout}
          focusedGroupId={focusedGroupId}
          onFocus={focus}
          onAddTab={addConsole}
          addLabel="New console"
        />
      </div>

      <footer className="session__footer">
        <button
          className="session__footer-path"
          title="Reveal in Finder"
          onClick={() => void window.maestro.app.revealPath(session.worktreePath)}
        >
          {local ? 'folder' : 'worktree'} · {homeRelative(session.worktreePath, home)}
        </button>
        <span className="spacer" />
        {status && (
          <span style={{ color: 'var(--color-neutral-600)' }}>
            +{status.insertions} −{status.deletions}
          </span>
        )}
        {setupLabel && <span className="setup-state">{setupLabel}</span>}
        {runningScripts.map((name) => (
          <span className="run-state" key={name}>
            <i className="ph ph-play" />
            {name}: running
          </span>
        ))}
      </footer>
    </main>
  )
}
