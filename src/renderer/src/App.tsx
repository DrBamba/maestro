import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isLocal } from '@shared/types'
import type {
  AgentStatus,
  BranchSync,
  DisposeAction,
  DisposeOptions,
  RemoveRepoOptions,
  GitStatus,
  LaunchSettings,
  MergeMode,
  Preferences,
  Repo,
  Session,
  StartMode,
  UpdateStatus
} from '@shared/types'
import Sidebar, { sidebarOrder, type PickMode } from './components/Sidebar'
import SessionView, {
  sessionStashKey,
  type SessionArrangement,
  type SessionWindowState
} from './components/SessionView'
import CommandPalette, { type Command } from './components/CommandPalette'
import NewSessionDialog from './components/NewSessionDialog'
import LocalSessionDialog from './components/LocalSessionDialog'
import MergeDialog from './components/MergeDialog'
import PrDialog from './components/PrDialog'
import ImportSessionDialog from './components/ImportSessionDialog'
import DisposeDialog from './components/DisposeDialog'
import BulkDisposeDialog from './components/BulkDisposeDialog'
import RenameDialog from './components/RenameDialog'
import RemoveRepoDialog from './components/RemoveRepoDialog'
import DeleteFolderDialog from './components/DeleteFolderDialog'
import SettingsDialog from './components/SettingsDialog'
import AboutDialog from './components/AboutDialog'
import Tooltip from './components/Tooltip'
import type { EditorHandle } from './components/EditorPane'
import type { ThemeName } from '@shared/theme'
import { initialTheme } from './theme'
import { playChime } from './lib/chime'
import { mac, useShortcuts } from './lib/shortcuts'
import { chordHint } from '@shared/shortcuts'

type Overlay =
  | 'palette'
  | 'new'
  | 'local'
  | 'import'
  | 'merge'
  | 'pr'
  | 'dispose'
  | 'bulkDispose'
  | 'rename'
  | 'removeRepo'
  | 'deleteFolder'
  | 'settings'
  | 'about'
  | null

/**
 * The number chord that reaches a session, or undefined for one no digit does — ⌘1 to ⌘8 count from
 * the top, and ⌘9 is the last row however many there are, so the rows in between have no digit.
 */
function digitHint(order: Session[], id: string): string | undefined {
  const at = order.findIndex((s) => s.id === id)
  if (at === -1) return undefined
  if (at < 8) return chordHint({ kind: 'session-at', index: at }, mac)
  if (at === order.length - 1) return chordHint({ kind: 'session-at', index: -1 }, mac)
  return undefined
}

/** Where the window keeps which sessions it had open. */
const OPENED_KEY = 'app:opened'
/** Set by main just before an update replaces the window, to the release's commit subject. */
const UPDATED_KEY = 'app:updated'
/** How often every session's branch is checked for the sidebar; the active one is polled faster. */
const SYNC_POLL_MS = 20_000

export default function App(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [agentStates, setAgentStates] = useState<Record<string, AgentStatus>>({})
  const [unseen, setUnseen] = useState<string[]>([])
  const [home, setHome] = useState('')
  const [localRoot, setLocalRoot] = useState('')
  const [worktreeRoot, setWorktreeRoot] = useState('')
  const [profile, setProfile] = useState<'stable' | 'dev' | 'custom'>('stable')
  const [sourceLabel, setSourceLabel] = useState('')
  const [ghAvailable, setGhAvailable] = useState(false)
  const [preferences, setPreferences] = useState<Preferences>({})
  // Seeded from the document rather than assumed dark, so the terminals a light session opens with
  // are created light instead of being repainted once the snapshot lands.
  const [theme, setTheme] = useState<ThemeName>(initialTheme)
  const [appStartedAt, setAppStartedAt] = useState(Date.now())

  const [overlay, setOverlay] = useState<Overlay>(null)
  const [newRepoId, setNewRepoId] = useState<string | null>(null)
  const [disposeAction, setDisposeAction] = useState<DisposeAction>('archive')
  /** Which session the dispose dialog is about — not always the active one. */
  const [disposeTarget, setDisposeTarget] = useState<string | null>(null)
  /** Rows picked in the sidebar for a bulk archive or delete. */
  const [picked, setPicked] = useState<string[]>([])
  /** Where a shift-click range starts: the row picked last. */
  const pickAnchor = useRef<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [removeRepoTarget, setRemoveRepoTarget] = useState<string | null>(null)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [openedIds, setOpenedIds] = useState<string[]>([])
  /*
   * What the previous window left: terminals still running for its tabs, and how it was arranged.
   * Refs, not state — read once, as each session's view mounts.
   */
  const heldTerminals = useRef<ReadonlySet<string>>(new Set())
  const windowState = useRef<Record<string, unknown>>({})
  const arrangements = useRef<Record<string, unknown>>({})
  const restoredWindow = useRef(false)
  const [localCollapsed, setLocalCollapsed] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, GitStatus | null>>({})
  const [syncs, setSyncs] = useState<Record<string, BranchSync>>({})
  const [remote, setRemote] = useState<string | null>(null)

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const claudePtys = useRef<Record<string, string>>({})
  /*
   * Held in a ref rather than read from state: the agent-state subscription is set up once, and
   * resubscribing on every preference change would drop states arriving in the gap. The setting has
   * to be live even so — turning the sound off has to silence the session already running.
   */
  const chimeOn = useRef(false)
  const editors = useRef<Record<string, EditorHandle | null>>({})

  // Kept current as well as saved, so a view mounted again in this run starts from the latest.
  const arrange = useCallback((sessionId: string, arrangement: SessionArrangement) => {
    arrangements.current[sessionId] = arrangement
    window.maestro.ui.arrange(sessionId, arrangement)
  }, [])

  const notice = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  // ── bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    void window.maestro.snapshot().then((snapshot) => {
      setRepos(snapshot.repos)
      setSessions(snapshot.sessions)
      setAgentStates(snapshot.agentStates)
      setUnseen(snapshot.unseenSessions)
      setProfile(snapshot.profile)
      setSourceLabel(snapshot.sourceLabel)
      setGhAvailable(snapshot.ghAvailable)
      setPreferences(snapshot.preferences)
      setTheme(snapshot.theme)
      setAppStartedAt(snapshot.appStartedAt)
      setHome(snapshot.home)
      setLocalRoot(snapshot.localRoot)
      setWorktreeRoot(snapshot.worktreeRoot)
      heldTerminals.current = new Set(snapshot.heldTerminals)
      windowState.current = snapshot.windowState
      arrangements.current = snapshot.arrangements
      restoredWindow.current = true
      const updated = snapshot.windowState[UPDATED_KEY]
      if (typeof updated === 'string') {
        notice(`Maestro updated: ${updated}`)
        window.maestro.ui.stash(UPDATED_KEY, null)
      }
      const first = snapshot.activeSessionId ?? snapshot.sessions.find((s) => !s.archived)?.id ?? null
      // Every session the last window had open comes back open, so its terminals are shown again.
      const known = new Set(snapshot.sessions.filter((s) => !s.archived).map((s) => s.id))
      const reopened = (Array.isArray(snapshot.windowState[OPENED_KEY]) ? snapshot.windowState[OPENED_KEY] : [])
        .filter((id: unknown): id is string => typeof id === 'string' && known.has(id))
      if (first) setActiveId(first)
      const opened = [...new Set([...(first ? [first] : []), ...reopened])]
      if (opened.length) setOpenedIds(opened)
    })
  }, [])

  useEffect(() => window.maestro.ui.busy(overlay !== null), [overlay])

  const [update, setUpdate] = useState<UpdateStatus>({ state: 'none' })
  useEffect(() => {
    void window.maestro.update.status().then(setUpdate)
    return window.maestro.update.onStatus(setUpdate)
  }, [])

  // Not until the last window's list has been read, or the empty one this starts with replaces it.
  useEffect(() => {
    if (restoredWindow.current) window.maestro.ui.stash(OPENED_KEY, openedIds)
  }, [openedIds])

  useEffect(() => window.maestro.onSessions(setSessions), [])
  useEffect(() => window.maestro.agent.onUnseen(setUnseen), [])
  // Main owns the answer to what `system` means, and pushes it again whenever the OS changes it.
  useEffect(() => window.maestro.onTheme(setTheme), [])

  useEffect(
    () =>
      window.maestro.agent.onState(({ sessionId, state, detail }) => {
        setAgentStates((prev) => {
          const current = prev[sessionId]
          if (current?.state === state && current.detail === detail) return prev
          // The ones that want the user; the agent getting on with things is not worth a sound.
          if (
            chimeOn.current &&
            (state === 'done' ||
              state === 'attention' ||
              state === 'interrupted' ||
              state === 'error')
          )
            playChime()
          return { ...prev, [sessionId]: { state, detail } }
        })
      }),
    []
  )

  useEffect(() => {
    chimeOn.current = preferences.chime === true
  }, [preferences.chime])

  /*
   * Marks the document rather than a single badge. Two Maestros side by side were easy to confuse,
   * and confusing them means typing into the wrong agent — so the signal has to survive being
   * glanced at, including in a screenshot of any part of the window.
   */
  useEffect(() => {
    document.documentElement.dataset.profile = profile
  }, [profile])

  /*
   * One attribute is the whole shell's ground: theme.css restates its primitives under
   * `:root[data-theme='light']` and every rule in app.css reads a token, so nothing else in the
   * renderer has to know which theme it is drawing.
   */
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!activeId) return
    void window.maestro.git.remote(activeId).then(setRemote)
  }, [activeId])

  /*
   * Every session's branch, for the sidebar's marks. Merges happen in terminals and on GitHub as
   * often as through Maestro, so this asks git rather than remembering what Maestro did. Focus is
   * when a push from elsewhere most likely just happened.
   */
  const branches = sessions.map((s) => `${s.id}:${s.branch}:${s.archived}`).join()
  useEffect(() => {
    const refresh = (): void => void window.maestro.git.sync().then(setSyncs)
    refresh()
    const timer = setInterval(refresh, SYNC_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [branches])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId]
  )
  const activeRepo = useMemo(
    () => repos.find((r) => r.id === activeSession?.repoId) ?? null,
    [repos, activeSession]
  )
  const activeStatus = activeId ? (statuses[activeId] ?? null) : null
  // The active session's status is polled far more often, so its row follows that.
  const rowSyncs = useMemo(
    () =>
      activeId && activeStatus
        ? { ...syncs, [activeId]: { ahead: activeStatus.ahead, landing: activeStatus.landing } }
        : syncs,
    [syncs, activeId, activeStatus]
  )
  const disposeSubject = useMemo(
    () => sessions.find((s) => s.id === disposeTarget) ?? null,
    [sessions, disposeTarget]
  )
  const removeRepoSubject = useMemo(
    () => repos.find((r) => r.id === removeRepoTarget) ?? null,
    [repos, removeRepoTarget]
  )

  const renameSubject = useMemo(
    () => sessions.find((s) => s.id === renameTarget) ?? null,
    [sessions, renameTarget]
  )

  const selectSession = useCallback((id: string) => {
    setActiveId(id)
    setOpenedIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
    void window.maestro.sessions.setActive(id)
  }, [])

  // ── actions ───────────────────────────────────────────────────────────────
  const addRepo = useCallback(async () => {
    const result = await window.maestro.repos.add()
    if (result.error) return notice(result.error)
    if (result.repo) {
      setRepos((prev) => (prev.some((r) => r.id === result.repo!.id) ? prev : [...prev, result.repo!]))
      notice(`Added ${result.repo.name}`)
    }
  }, [notice])

  const openRemoveRepo = useCallback((repoId: string) => {
    setRemoveRepoTarget(repoId)
    setOverlay('removeRepo')
  }, [])

  const removeRepo = useCallback(
    async (repoId: string, options: RemoveRepoOptions) => {
      const repo = repos.find((r) => r.id === repoId)
      const touched = new Set(sessions.filter((s) => s.repoId === repoId).map((s) => s.id))
      const result = await window.maestro.repos.remove(repoId, options)
      // Even a failure part-way may have archived or deleted some of them, so their views close.
      setOpenedIds((ids) => ids.filter((id) => !touched.has(id)))
      setActiveId((current) => (current && touched.has(current) ? null : current))
      if (result.ok) {
        setRepos((prev) => prev.filter((r) => r.id !== repoId))
        if (repo) notice(`Removed ${repo.name}`)
      }
      return result
    },
    [repos, sessions, notice]
  )

  const openDeleteFolder = useCallback((path: string) => {
    setDeleteFolderTarget(path)
    setOverlay('deleteFolder')
  }, [])

  const deleteLocalFolder = useCallback(
    async (path: string, deleteFolder: boolean) => {
      const touched = new Set(
        sessions.filter((s) => isLocal(s) && s.worktreePath === path).map((s) => s.id)
      )
      const result = await window.maestro.sessions.deleteFolder(path, deleteFolder)
      setOpenedIds((ids) => ids.filter((id) => !touched.has(id)))
      setActiveId((current) => (current && touched.has(current) ? null : current))
      if (result.ok) notice(deleteFolder ? 'Sessions and folder deleted' : 'Sessions deleted')
      return result
    },
    [sessions, notice]
  )

  const createSession = useCallback(
    async (
      repoId: string,
      name: string,
      base: string,
      mode: StartMode,
      launch: LaunchSettings
    ): Promise<string | null> => {
      const result = await window.maestro.sessions.create(repoId, name, base, mode, launch)
      if (result.error) return result.error
      if (result.session) {
        selectSession(result.session.id)
        setOverlay(null)
        notice(
          mode === 'continue'
            ? `Worktree created on ${result.session.branch} · Claude started on it`
            : 'Worktree created · Claude started on it'
        )
      }
      return null
    },
    [notice, selectSession]
  )

  /** Opens a plain folder — no worktree, no branch, just a place to run Claude. */
  const createLocalSession = useCallback(
    async (text: string, path: string, launch: LaunchSettings): Promise<string | null> => {
      const result = await window.maestro.sessions.createLocal(text, path, launch)
      if (result.error) return result.error
      if (result.session) {
        selectSession(result.session.id)
        setOverlay(null)
        notice(path ? `Opened ${result.session.name}` : 'Folder created · Claude launched')
      }
      return null
    },
    [notice, selectSession]
  )

  /**
   * Adopts an existing worktree. `pick` routes through the folder dialog instead of the list;
   * `relocate` first moves the work off the primary clone into a worktree of its own.
   */
  const importWorktree = useCallback(
    async (path: string | null, relocate = false): Promise<string | null> => {
      const result = relocate && path
        ? await window.maestro.sessions.relocate(path)
        : path
          ? await window.maestro.sessions.import(path)
          : await window.maestro.sessions.importPick()
      if (result.error) return result.error
      if (result.session) {
        setRepos(await window.maestro.snapshot().then((s) => s.repos))
        selectSession(result.session.id)
        setOverlay(null)
        notice(`Imported ${result.session.branch} · resuming Claude`)
      }
      return null
    },
    [notice, selectSession]
  )

  /** Both archiving and deleting are destructive, so both go through the confirmation dialog. */
  const openRename = useCallback((sessionId: string) => {
    setRenameTarget(sessionId)
    setOverlay('rename')
  }, [])

  const renameSession = useCallback(
    async (name: string) => {
      if (!renameTarget) return
      await window.maestro.sessions.rename(renameTarget, name)
      notice(`Renamed to “${name}”`)
    },
    [renameTarget, notice]
  )

  // A session that went away elsewhere drops out of the selection with it.
  const selected = useMemo(
    () => picked.filter((id) => sessions.some((s) => s.id === id)),
    [picked, sessions]
  )

  const clearSelection = useCallback(() => {
    setPicked([])
    pickAnchor.current = null
  }, [])

  const openBulkDispose = useCallback((action: DisposeAction) => {
    setDisposeAction(action)
    setOverlay('bulkDispose')
  }, [])

  const runBulkDispose = useCallback(
    async (jobs: { id: string; options: DisposeOptions }[], action: DisposeAction) => {
      const done = new Set<string>()
      const failed: string[] = []
      // One at a time: sessions of one repo share its git lock.
      for (const job of jobs) {
        const result = await window.maestro.sessions.dispose(job.id, job.options)
        if (result.ok) done.add(job.id)
        else {
          const name = sessions.find((s) => s.id === job.id)?.name ?? job.id
          failed.push(`“${name}”: ${result.error ?? 'failed'}`)
        }
      }
      setOpenedIds((ids) => ids.filter((id) => !done.has(id)))
      setActiveId((current) => (current && done.has(current) ? null : current))
      setPicked((ids) => ids.filter((id) => !done.has(id)))
      if (done.size > 0) {
        const count = done.size === 1 ? '1 session' : `${done.size} sessions`
        notice(action === 'archive' ? `Archived ${count}` : `Deleted ${count}`)
      }
      if (failed.length === 0) {
        clearSelection()
        return { ok: true }
      }
      return {
        ok: false,
        error: `${failed.length} of ${jobs.length} failed. ${failed.join(' ')}`
      }
    },
    [sessions, notice, clearSelection]
  )

  const openDispose = useCallback((sessionId: string, action: DisposeAction) => {
    setDisposeTarget(sessionId)
    setDisposeAction(action)
    setOverlay('dispose')
  }, [])

  const runDispose = useCallback(
    async (options: DisposeOptions) => {
      const target = disposeTarget
      if (!target) return { ok: false, error: 'No session selected.' }
      const result = await window.maestro.sessions.dispose(target, options)
      if (result.ok) {
        setOpenedIds((ids) => ids.filter((id) => id !== target))
        setActiveId((current) => (current === target ? null : current))
        notice(
          options.action === 'archive'
            ? 'Archived — restore it from the sidebar'
            : 'Session deleted'
        )
      }
      return result
    },
    [disposeTarget, notice]
  )

  const restoreSession = useCallback(
    async (id: string) => {
      const result = await window.maestro.sessions.restore(id)
      if (!result.ok) return notice(result.error ?? 'Could not restore the session.')
      selectSession(id)
      notice('Worktree recreated from the branch')
    },
    [notice, selectSession]
  )

  /**
   * Written through to main and adopted from its answer, so what is on screen is what will be read
   * at launch rather than a guess at what the patch did.
   *
   * Permission mode is fixed when the process starts, so this reaches sessions started from here on
   * and no others — which is why the confirmation says so rather than implying it took effect
   * everywhere.
   */
  const updatePreferences = useCallback(
    async (patch: Partial<Preferences>) => {
      setPreferences(await window.maestro.preferences.update(patch))
      /*
       * No toast for the theme: main pushes the resolved ground back and the entire window — shell,
       * terminals and the embedded editor — repaints in front of the person who asked for it, which
       * is a louder confirmation than any sentence.
       */
      if ('permissionMode' in patch) {
        notice(
          patch.permissionMode === 'auto'
            ? 'Auto mode on — sessions you start from now on launch in it'
            : 'Auto mode off — Claude Code’s own settings decide again'
        )
      }
    },
    [notice]
  )

  const toggleRepo = useCallback((repoId: string) => {
    setRepos((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, collapsed: !r.collapsed } : r))
    )
    const repo = repos.find((r) => r.id === repoId)
    if (repo) void window.maestro.repos.update(repoId, { collapsed: !repo.collapsed })
  }, [repos])

  const reorderRepos = useCallback((ids: string[]) => {
    setRepos((prev) => ids.flatMap((id) => prev.filter((r) => r.id === id)))
    void window.maestro.repos.reorder(ids)
  }, [])

  const runMerge = useCallback(
    async (mode: MergeMode, archiveAfter: boolean) => {
      if (!activeId) {
        return { ok: false, conflicts: [], message: 'No active session.' }
      }
      const result = await window.maestro.git.merge({ sessionId: activeId, mode, archiveAfter })
      if (result.ok) {
        notice(
          mode === 'rebase'
            ? `Rebased onto ${activeRepo?.defaultBranch ?? 'main'}${archiveAfter ? ' · worktree archived' : ''}`
            : `Merged into ${activeRepo?.defaultBranch ?? 'main'}${archiveAfter ? ' · worktree archived' : ''}`
        )
        if (archiveAfter) {
          setOpenedIds((ids) => ids.filter((id) => id !== activeId))
          setActiveId(null)
        }
      }
      return result
    },
    [activeId, activeRepo, notice]
  )

  const handToClaude = useCallback(
    (paths: string[]) => {
      if (!activeId) return
      const ptyId = claudePtys.current[activeId]
      if (!ptyId) return notice('The Claude terminal is not running.')
      const list = paths.join(', ')
      window.maestro.pty.write(
        ptyId,
        `Resolve the merge conflicts in these files, then stage them: ${list}\n`
      )
      setOverlay(null)
      notice('Sent the conflicts to Claude')
    },
    [activeId, notice]
  )

  const openConflicts = useCallback(
    (paths: string[]) => {
      if (!activeId || !activeSession) return
      const handle = editors.current[activeId]
      if (!handle) return notice('The editor is not running yet.')
      const first = paths[0]
      if (first) handle.openFile(`${activeSession.worktreePath}/${first}`)
      setOverlay(null)
    },
    [activeId, activeSession, notice]
  )

  // ── keyboard ──────────────────────────────────────────────────────────────
  /** The rows on screen, which is what the number chords count and what stepping walks. */
  const navOrder = useMemo(
    () => sidebarOrder(repos, sessions, localCollapsed),
    [repos, sessions, localCollapsed]
  )

  /**
   * ⌘-click and shift-click, as in a file list. The open session counts as already picked, so
   * clicking one row and ⌘-clicking another takes both.
   */
  const pickSession = useCallback(
    (id: string, mode: PickMode) => {
      const order = navOrder.map((s) => s.id)
      const seeded =
        selected.length === 0 && activeId && activeId !== id && order.includes(activeId)
          ? [activeId]
          : selected
      const anchor = pickAnchor.current ?? (seeded.length ? seeded[seeded.length - 1] : null)
      const from = anchor ? order.indexOf(anchor) : -1
      const to = order.indexOf(id)
      if (mode === 'range' && from >= 0 && to >= 0) {
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1)
        setPicked([...seeded.filter((x) => !span.includes(x)), ...span])
      } else {
        setPicked(seeded.includes(id) ? seeded.filter((x) => x !== id) : [...seeded, id])
      }
      pickAnchor.current = id
    },
    [navOrder, selected, activeId]
  )

  // Escape lets go of a selection, as long as no dialog is the thing being dismissed.
  useEffect(() => {
    if (selected.length === 0 || overlay !== null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearSelection()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected.length, overlay, clearSelection])

  /**
   * The next session with something for the user: one asking a question first, then one that
   * finished while they were looking elsewhere.
   *
   * Searched from the one after the active session and wrapping past it, so pressing again walks the
   * queue rather than bouncing between the same two. The session already on screen is not a
   * candidate — it is being looked at, which is what the chord was for.
   */
  const nextWaiting = useCallback((): string | null => {
    const at = navOrder.findIndex((s) => s.id === activeId)
    const rotated = at === -1 ? navOrder : [...navOrder.slice(at + 1), ...navOrder.slice(0, at)]
    const unseenSet = new Set(unseen)
    return (
      rotated.find((s) => agentStates[s.id]?.state === 'attention')?.id ??
      rotated.find((s) => unseenSet.has(s.id))?.id ??
      null
    )
  }, [navOrder, activeId, agentStates, unseen])

  useShortcuts((shortcut) => {
    if (shortcut.kind === 'palette') {
      setOverlay((current) => (current === 'palette' ? null : 'palette'))
      return true
    }
    if (shortcut.kind === 'new-session') {
      setNewRepoId(activeRepo?.id ?? null)
      setOverlay('new')
      return true
    }
    // Nothing navigates behind an open dialog: the answer being typed into it is the thing in hand.
    if (overlay) return false

    if (shortcut.kind === 'session-step') {
      if (navOrder.length === 0) return true
      const at = navOrder.findIndex((s) => s.id === activeId)
      const to = (at + shortcut.delta + navOrder.length) % navOrder.length
      selectSession(navOrder[at === -1 ? 0 : to].id)
      return true
    }
    if (shortcut.kind === 'session-at') {
      const target = shortcut.index === -1 ? navOrder[navOrder.length - 1] : navOrder[shortcut.index]
      if (target) selectSession(target.id)
      return true
    }
    if (shortcut.kind === 'session-attention') {
      const target = nextWaiting()
      if (target) selectSession(target)
      else notice('Nothing else waiting on you')
      return true
    }
    return false
  })

  // ── command palette ───────────────────────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new',
        icon: 'ph ph-plus',
        label: 'New session',
        hint: chordHint({ kind: 'new-session' }, mac),
        run: () => {
          setNewRepoId(activeRepo?.id ?? null)
          setOverlay('new')
        }
      },
      {
        id: 'local',
        icon: 'ph ph-folder-open',
        label: 'New local session…',
        hint: 'a folder, no repo',
        run: () => setOverlay('local')
      },
      {
        id: 'import',
        icon: 'ph ph-arrow-counter-clockwise',
        label: 'Import existing worktree…',
        run: () => setOverlay('import')
      },
      {
        id: 'add-repo',
        icon: 'ph ph-folder-plus',
        label: 'Add repo',
        run: () => {
          setOverlay(null)
          void addRepo()
        }
      },
      ...repos.map((repo) => ({
        id: `remove-repo-${repo.id}`,
        icon: 'ph ph-trash',
        label: `Remove repo: ${repo.name}`,
        hint: 'comes back when added again',
        run: () => openRemoveRepo(repo.id)
      })),
      {
        id: 'settings',
        icon: 'ph ph-sliders-horizontal',
        label: 'Settings…',
        hint: 'appearance, how Claude starts',
        run: () => setOverlay('settings')
      }
    ]

    if (navOrder.length > 1) {
      list.push({
        id: 'attention',
        icon: 'ph ph-bell',
        label: 'Next session waiting on you',
        hint: chordHint({ kind: 'session-attention' }, mac),
        run: () => {
          const target = nextWaiting()
          setOverlay(null)
          if (target) selectSession(target)
          else notice('Nothing else waiting on you')
        }
      })
    }

    for (const session of sessions.filter((s) => !s.archived && s.id !== activeId)) {
      list.push({
        id: `switch-${session.id}`,
        icon: 'ph ph-terminal-window',
        label: `Switch to: ${session.name}`,
        // The chord that gets there, for the rows a digit reaches — the first eight, and the last.
        hint: digitHint(navOrder, session.id),
        run: () => {
          selectSession(session.id)
          setOverlay(null)
        }
      })
    }

    if (activeSession) {
      const place = isLocal(activeSession) ? 'folder' : 'worktree'
      list.push({
        id: 'open-vscode',
        icon: 'ph ph-arrow-square-out',
        label: `Open ${place} in VS Code`,
        run: () => {
          setOverlay(null)
          void window.maestro.editor.openExternal(activeSession.worktreePath)
          notice(`Opening ${place} in VS Code…`)
        }
      })

      // Merging and opening a PR need a repo behind the session; a local one has none.
      if (activeRepo) {
        list.push(
          {
            id: 'merge',
            icon: 'ph ph-arrows-merge',
            label: `Merge into ${activeRepo.defaultBranch}`,
            run: () => setOverlay('merge')
          },
          {
            id: 'pr',
            icon: 'ph ph-git-pull-request',
            label: 'Create pull request',
            run: () => setOverlay('pr')
          },
          /*
           * Both go to the session, which owns the editor and the setup tab — the same route the run
           * scripts take. Editing writes the script into this worktree if the branch has none, so
           * the way to start one is to ask to edit it.
           */
          {
            id: 'setup-edit',
            icon: 'ph ph-file-code',
            label: 'Edit setup script',
            hint: '.maestro/setup.sh',
            run: () => {
              setOverlay(null)
              window.dispatchEvent(
                new CustomEvent('maestro:setup-script', {
                  detail: { sessionId: activeSession.id, action: 'edit' }
                })
              )
            }
          },
          {
            id: 'setup-run',
            icon: 'ph ph-play',
            label: 'Run setup script',
            hint: 'in this worktree',
            run: () => {
              setOverlay(null)
              window.dispatchEvent(
                new CustomEvent('maestro:setup-script', {
                  detail: { sessionId: activeSession.id, action: 'run' }
                })
              )
            }
          }
        )
      }

      list.push(
        {
          id: 'rename',
          icon: 'ph ph-pencil-simple',
          label: 'Rename session…',
          run: () => openRename(activeSession.id)
        },
        {
          id: 'archive',
          icon: 'ph ph-archive',
          label: 'Archive session…',
          hint: place === 'folder' ? 'keeps the folder' : 'keeps the branch',
          run: () => openDispose(activeSession.id, 'archive')
        },
        {
          id: 'delete',
          icon: 'ph ph-trash',
          label: 'Delete session…',
          hint: 'not reversible',
          run: () => openDispose(activeSession.id, 'delete')
        }
      )

      for (const session of sessions.filter((s) => s.archived)) {
        list.push(
          {
            id: `restore-${session.id}`,
            icon: 'ph ph-arrow-counter-clockwise',
            label: `Restore session: ${session.name}`,
            run: () => {
              setOverlay(null)
              void restoreSession(session.id)
            }
          },
          {
            id: `delete-archived-${session.id}`,
            icon: 'ph ph-trash',
            label: `Delete archived session: ${session.name}`,
            hint: 'not reversible',
            run: () => openDispose(session.id, 'delete')
          }
        )
      }

      for (const script of activeRepo?.runScripts ?? []) {
        list.push({
          id: `script-${script.id}`,
          icon: 'ph ph-play',
          label: `Run script: ${script.name}`,
          run: () => {
            setOverlay(null)
            // The session says what happened: a script asked for while setup is still running is
            // queued rather than started, and only the session view knows which.
            window.dispatchEvent(
              new CustomEvent('maestro:run-script', {
                detail: { sessionId: activeSession.id, scriptId: script.id }
              })
            )
          }
        })
      }
    }

    return list
  }, [
    sessions,
    activeId,
    activeSession,
    activeRepo,
    addRepo,
    repos,
    notice,
    openDispose,
    openRemoveRepo,
    openRename,
    restoreSession,
    selectSession,
    navOrder,
    nextWaiting
  ])

  const openSessions = openedIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is Session => Boolean(s))

  return (
    <div className="app">
      <Sidebar
        repos={repos}
        sessions={sessions}
        agentStates={agentStates}
        syncs={rowSyncs}
        unseen={unseen}
        profile={profile}
        sourceLabel={sourceLabel}
        activeId={activeId}
        now={now}
        selected={selected}
        onSelect={(id) => {
          clearSelection()
          selectSession(id)
        }}
        onPick={pickSession}
        onBulk={openBulkDispose}
        onClearSelection={clearSelection}
        onNewSession={(repoId) => {
          setNewRepoId(repoId ?? activeRepo?.id ?? null)
          setOverlay('new')
        }}
        onNewLocal={() => setOverlay('local')}
        localCollapsed={localCollapsed}
        onToggleLocal={() => setLocalCollapsed((v) => !v)}
        onToggleRepo={toggleRepo}
        onReorderRepos={reorderRepos}
        onAddRepo={() => void addRepo()}
        onRemoveRepo={openRemoveRepo}
        onDeleteLocalFolder={openDeleteFolder}
        onRestore={(id) => void restoreSession(id)}
        onArchive={(id) => openDispose(id, 'archive')}
        onDelete={(id) => openDispose(id, 'delete')}
        onRename={openRename}
        onOpenSettings={() => setOverlay('settings')}
        onOpenAbout={() => setOverlay('about')}
        update={update}
        onUpdate={() => window.maestro.update.press()}
        onUpdateCancel={() => window.maestro.update.cancel()}
        onUpdateLog={() => window.maestro.update.openLog()}
      />

      {openSessions.map((session) => {
        // Null for a local session, which has no repo — SessionView drops the git parts for it.
        const repo = repos.find((r) => r.id === session.repoId) ?? null
        return (
          <SessionView
            key={session.id}
            session={session}
            repo={repo}
            active={session.id === activeId}
            dialogOpen={overlay !== null}
            home={home}
            // Age is the usual test, but a session archived and restored in this same run is
            // younger than the app and still has a conversation waiting for it.
            resume={session.createdAt < appStartedAt || session.restoredAt !== undefined}
            sharedFolder={
              isLocal(session) &&
              sessions.some(
                (s) =>
                  s.id !== session.id &&
                  isLocal(s) &&
                  !s.archived &&
                  s.worktreePath === session.worktreePath
              )
            }
            preferences={preferences}
            theme={theme}
            onPreferences={(patch) => void updatePreferences(patch)}
            onNotice={notice}
            heldTerminals={heldTerminals.current}
            restored={windowState.current[sessionStashKey(session.id)] as SessionWindowState | undefined}
            arranged={arrangements.current[session.id] as SessionArrangement | undefined}
            onArrange={arrange}
            onClaudePty={(sessionId, ptyId) => {
              claudePtys.current[sessionId] = ptyId
            }}
            onEditorHandle={(sessionId, handle) => {
              editors.current[sessionId] = handle
            }}
            onStatus={(sessionId, status) =>
              setStatuses((prev) => (prev[sessionId] === status ? prev : { ...prev, [sessionId]: status }))
            }
          />
        )
      })}

      {!activeSession && (
        <div className="empty">
          <i className="ph ph-music-notes-simple" />
          <div className="empty__title">Nothing running</div>
          <div className="empty__body">
            {repos.length === 0
              ? 'Add a repo, then create a session — each gets its own worktree, branch and Claude Code terminal.'
              : 'Create a session to cut a worktree and start Claude Code in it.'}
          </div>
          <button
            className="btn btn--primary"
            onClick={() => (repos.length === 0 ? void addRepo() : setOverlay('new'))}
          >
            <i className="ph ph-plus" style={{ fontSize: 15 }} />
            {repos.length === 0 ? 'Add repo' : 'New session'}
          </button>
          {/* The way in for work that is not a branch — a folder and a terminal, nothing else. */}
          <button className="modal__link" onClick={() => setOverlay('local')}>
            or open a local folder, with no repo behind it
          </button>
        </div>
      )}

      {overlay === 'palette' && (
        <CommandPalette commands={commands} onClose={() => setOverlay(null)} />
      )}

      {overlay === 'new' && (
        <NewSessionDialog
          repos={repos}
          initialRepoId={newRepoId}
          autoMode={preferences.permissionMode === 'auto'}
          onAutoMode={(on) => void updatePreferences({ permissionMode: on ? 'auto' : undefined })}
          onClose={() => setOverlay(null)}
          onCreate={createSession}
          onImportInstead={() => setOverlay('import')}
        />
      )}

      {overlay === 'local' && (
        <LocalSessionDialog
          home={home}
          localRoot={localRoot}
          openLocal={sessions.filter((s) => isLocal(s) && !s.archived)}
          autoMode={preferences.permissionMode === 'auto'}
          onAutoMode={(on) => void updatePreferences({ permissionMode: on ? 'auto' : undefined })}
          onClose={() => setOverlay(null)}
          onCreate={createLocalSession}
        />
      )}

      {overlay === 'about' && (
        <AboutDialog
          profile={profile}
          sourceLabel={sourceLabel}
          worktreeRoot={worktreeRoot}
          localRoot={localRoot}
          home={home}
          onClose={() => setOverlay(null)}
        />
      )}

      {overlay === 'settings' && (
        <SettingsDialog
          preferences={preferences}
          onChange={(patch) => void updatePreferences(patch)}
          onClose={() => setOverlay(null)}
        />
      )}

      {overlay === 'dispose' && disposeSubject && (
        <DisposeDialog
          sessionId={disposeSubject.id}
          sessionName={disposeSubject.name}
          home={home}
          initialAction={disposeAction}
          onClose={() => setOverlay(null)}
          onDispose={runDispose}
        />
      )}

      {overlay === 'bulkDispose' && selected.length > 0 && (
        <BulkDisposeDialog
          sessions={selected.map((id) => ({
            id,
            name: sessions.find((s) => s.id === id)?.name ?? id
          }))}
          home={home}
          initialAction={disposeAction}
          busyCount={
            selected.filter((id) => {
              const state = agentStates[id]?.state
              return state === 'working' || state === 'delegating'
            }).length
          }
          onClose={() => setOverlay(null)}
          onDispose={runBulkDispose}
        />
      )}

      {overlay === 'removeRepo' && removeRepoSubject && (
        <RemoveRepoDialog
          repoId={removeRepoSubject.id}
          repoName={removeRepoSubject.name}
          repoPath={
            home && removeRepoSubject.path.startsWith(home)
              ? `~${removeRepoSubject.path.slice(home.length)}`
              : removeRepoSubject.path
          }
          busyCount={
            sessions.filter((s) => {
              const state = agentStates[s.id]?.state
              return s.repoId === removeRepoSubject.id && (state === 'working' || state === 'delegating')
            }).length
          }
          onClose={() => setOverlay(null)}
          onRemove={(options) => removeRepo(removeRepoSubject.id, options)}
        />
      )}

      {overlay === 'deleteFolder' && deleteFolderTarget && (
        <DeleteFolderDialog
          path={deleteFolderTarget}
          name={deleteFolderTarget.replace(/\/+$/, '').split('/').pop() || deleteFolderTarget}
          home={home}
          busyCount={
            sessions.filter((s) => {
              const state = agentStates[s.id]?.state
              return (
                isLocal(s) &&
                !s.archived &&
                s.worktreePath === deleteFolderTarget &&
                (state === 'working' || state === 'delegating')
              )
            }).length
          }
          onClose={() => setOverlay(null)}
          onDelete={(deleteFolder) => deleteLocalFolder(deleteFolderTarget, deleteFolder)}
        />
      )}

      {overlay === 'rename' && renameSubject && (
        <RenameDialog
          sessionName={renameSubject.name}
          branch={renameSubject.branch}
          onClose={() => setOverlay(null)}
          onRename={renameSession}
        />
      )}

      {overlay === 'import' && (
        <ImportSessionDialog
          home={home}
          onClose={() => setOverlay(null)}
          onImport={(path) => importWorktree(path)}
          onRelocate={(path) => importWorktree(path, true)}
          onPick={() => importWorktree(null)}
        />
      )}

      {overlay === 'merge' && activeSession && activeRepo && (
        <MergeDialog
          branch={activeSession.branch}
          defaultBranch={activeRepo.defaultBranch}
          status={activeStatus}
          commitCount={activeStatus?.ahead ?? 0}
          onClose={() => setOverlay(null)}
          onMerge={runMerge}
          onOpenConflicts={openConflicts}
          onHandToClaude={handToClaude}
        />
      )}

      {overlay === 'pr' && activeSession && activeRepo && (
        <PrDialog
          sessionId={activeSession.id}
          sessionName={activeSession.name}
          branch={activeSession.branch}
          defaultBranch={activeRepo.defaultBranch}
          remote={remote}
          ghAvailable={ghAvailable}
          fileCount={activeStatus?.files.length ?? 0}
          onClose={() => setOverlay(null)}
          onCreate={async (title, body) => {
            const result = await window.maestro.git.createPr({
              sessionId: activeSession.id,
              title,
              body
            })
            if (result.ok) {
              notice(result.number ? `PR #${result.number} opened · CI running` : 'Pull request opened')
            }
            return result
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* Mounted once, for every `data-tip` in the window. */}
      <Tooltip />
    </div>
  )
}
