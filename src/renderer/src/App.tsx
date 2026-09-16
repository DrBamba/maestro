import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isLocal } from '@shared/types'
import type {
  AgentStatus,
  DisposeAction,
  DisposeOptions,
  GitStatus,
  LaunchSettings,
  MergeMode,
  Preferences,
  Repo,
  Session,
  StartMode
} from '@shared/types'
import Sidebar from './components/Sidebar'
import SessionView from './components/SessionView'
import CommandPalette, { type Command } from './components/CommandPalette'
import NewSessionDialog from './components/NewSessionDialog'
import LocalSessionDialog from './components/LocalSessionDialog'
import MergeDialog from './components/MergeDialog'
import PrDialog from './components/PrDialog'
import ImportSessionDialog from './components/ImportSessionDialog'
import DisposeDialog from './components/DisposeDialog'
import RenameDialog from './components/RenameDialog'
import SettingsDialog from './components/SettingsDialog'
import Tooltip from './components/Tooltip'
import type { EditorHandle } from './components/EditorPane'
import { shortcut } from './lib/format'
import type { ThemeName } from '@shared/theme'
import { initialTheme } from './theme'
import { playChime } from './lib/chime'

type Overlay =
  | 'palette'
  | 'new'
  | 'local'
  | 'import'
  | 'merge'
  | 'pr'
  | 'dispose'
  | 'rename'
  | 'settings'
  | null

export default function App(): React.JSX.Element {
  const [repos, setRepos] = useState<Repo[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [agentStates, setAgentStates] = useState<Record<string, AgentStatus>>({})
  const [unseen, setUnseen] = useState<string[]>([])
  const [home, setHome] = useState('')
  const [localRoot, setLocalRoot] = useState('')
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
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [openedIds, setOpenedIds] = useState<string[]>([])
  const [statuses, setStatuses] = useState<Record<string, GitStatus | null>>({})
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
      const first = snapshot.activeSessionId ?? snapshot.sessions.find((s) => !s.archived)?.id ?? null
      if (first) {
        setActiveId(first)
        setOpenedIds([first])
      }
    })
  }, [])

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

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId]
  )
  const activeRepo = useMemo(
    () => repos.find((r) => r.id === activeSession?.repoId) ?? null,
    [repos, activeSession]
  )
  const activeStatus = activeId ? (statuses[activeId] ?? null) : null
  const disposeSubject = useMemo(
    () => sessions.find((s) => s.id === disposeTarget) ?? null,
    [sessions, disposeTarget]
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOverlay((current) => (current === 'palette' ? null : 'palette'))
      } else if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setNewRepoId(activeRepo?.id ?? null)
        setOverlay('new')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeRepo])

  // ── command palette ───────────────────────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new',
        icon: 'ph ph-plus',
        label: 'New session',
        hint: shortcut('n'),
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
      {
        id: 'settings',
        icon: 'ph ph-sliders-horizontal',
        label: 'Settings…',
        hint: 'appearance, how Claude starts',
        run: () => setOverlay('settings')
      }
    ]

    for (const session of sessions.filter((s) => !s.archived && s.id !== activeId)) {
      list.push({
        id: `switch-${session.id}`,
        icon: 'ph ph-terminal-window',
        label: `Switch to: ${session.name}`,
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
    notice,
    openDispose,
    openRename,
    restoreSession,
    selectSession
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
        unseen={unseen}
        profile={profile}
        sourceLabel={sourceLabel}
        activeId={activeId}
        now={now}
        onSelect={selectSession}
        onNewSession={(repoId) => {
          setNewRepoId(repoId ?? activeRepo?.id ?? null)
          setOverlay('new')
        }}
        onNewLocal={() => setOverlay('local')}
        onToggleRepo={toggleRepo}
        onAddRepo={() => void addRepo()}
        onRestore={(id) => void restoreSession(id)}
        onArchive={(id) => openDispose(id, 'archive')}
        onDelete={(id) => openDispose(id, 'delete')}
        onRename={openRename}
        onOpenSettings={() => setOverlay('settings')}
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
