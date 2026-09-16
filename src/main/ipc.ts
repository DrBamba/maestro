import { ipcMain, dialog, shell, app, Notification, BrowserWindow } from 'electron'
import { basename } from 'node:path'
import type {
  AgentStatus,
  DisposeOptions,
  BaseOption,
  ClaudeLaunch,
  CodeServerInfo,
  Conversation,
  ImportableWorktree,
  LaunchSettings,
  Commit,
  GitStatus,
  MergeInput,
  MergeResult,
  PrInput,
  PrResult,
  PrStatus,
  Preferences,
  RemoveRepoOptions,
  Repo,
  Session,
  StartMode
} from '@shared/types'
import { platformOf } from '@shared/platform'
import { THEMES, type ThemeName } from '@shared/theme'
import { onSystemThemeChange, resolvedTheme, syncNativeTheme } from './theme'
import { store } from './store'
import * as git from './git'
import { ptys } from './pty'
import { agentStates, installHooks } from './agentState'
import { codeServer } from './codeServer'
import { listConversations } from './claudeHistory'
import { profile, sourceLabel, type Profile } from './profile'
import { titleWatcher } from './autoTitle'
import { createSetupScript, setupScriptIn, SETUP_SCRIPT_REL } from './setupScript'
import {
  addRepo,
  applyGeneratedTitle,
  archivePlan,
  disposeSession,
  restoreSession,
  createSession,
  createLocalSession,
  hasClaudeHistory,
  importableWorktrees,
  importWorktree,
  launchClaude,
  relocatePlan,
  relocateToWorktree,
  removeRepo,
  removeRepoPlan,
  localFolderPlan,
  deleteLocalFolder,
  runSetupScript,
  syncRelocatedHistory,
  localRoot,
  worktreeRoot
} from './sessions'

export interface Snapshot {
  repos: Repo[]
  sessions: Session[]
  activeSessionId: string | null
  agentStates: Record<string, AgentStatus>
  worktreeRoot: string
  /** Where a local session's folder is made, when Maestro makes it. */
  localRoot: string
  /** The user's home directory, for shortening displayed paths. */
  home: string
  ghAvailable: boolean
  /** Sessions that finished or asked for input while the user was looking elsewhere. */
  unseenSessions: string[]
  /** Which data directory this instance is using — 'dev' when run unpackaged. */
  profile: Profile
  /** The branch this instance is running out of, empty when packaged. */
  sourceLabel: string
  /** App-wide settings the user chose — how Claude starts, and whatever joins it later. */
  preferences: Preferences
  /**
   * The ground to paint on, already resolved — `system` is a question about this machine, and main
   * is the only place it gets asked, so the shell and its terminals are handed the answer.
   */
  theme: ThemeName
  /**
   * Lets the renderer tell a restored session from a fresh one, so restored ones relaunch
   * Claude with --continue instead of starting a new conversation (PLAN.md §7 persistence).
   */
  appStartedAt: number
}

const APP_STARTED_AT = Date.now()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function pushSessions(): void {
  broadcast('state:sessions', store.sessions)
}

/** The ground everything is currently on, so a change that changes nothing costs nothing. */
let appliedTheme: ThemeName | null = null

/**
 * Puts the whole app on one ground: the shell and its terminals, the embedded workbench, and the
 * chrome Electron draws for us.
 *
 * Guarded on the resolved theme rather than the preference, because most of what follows is work —
 * a settings file, a window repaint, a workbench reloaded at the other end — and moving between
 * `dark` and a `system` that resolves to dark changes nothing anyone can see. Setting the native
 * source is outside the guard: that is the preference itself, not what it resolved to.
 */
export async function applyTheme(): Promise<void> {
  syncNativeTheme()
  const theme = resolvedTheme()
  if (theme === appliedTheme) return
  appliedTheme = theme

  // The ground behind the renderer, seen while the window is being laid out or resized past it.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(THEMES[theme].chrome)
  }

  /*
   * The editor's settings before the announcement, not after. A running workbench does not notice
   * its settings file changing, so the renderer reloads the embed when it hears about the theme —
   * and a reload that overtakes this write would read the old colours and paint them right back.
   */
  await codeServer.applyTheme()
  broadcast('state:theme', theme)
}

/**
 * Puts Electron on the chosen theme at startup, and keeps following the OS from there — which
 * only ever amounts to anything while the preference is `system`, since a fixed one resolves the
 * same way whatever the machine does.
 */
export function wireTheme(): void {
  syncNativeTheme()
  appliedTheme = resolvedTheme()
  onSystemThemeChange(() => void applyTheme())
}

/**
 * Sessions that reached done or attention while the user was looking elsewhere.
 *
 * Without this, a finished session is indistinguishable from one finished an hour ago — you hear
 * the chime, then have to open each session to find out which one it was. Cleared when the session
 * is actually looked at.
 */
const unseen = new Set<string>()

/**
 * Restores what was on screen before the last quit. Both the agent state and the unseen marker were
 * memory-only, so relaunching reset every dot to idle — a session that had finished came back
 * looking untouched, and the completion it was reporting was simply lost.
 */
export function restoreAgentStates(): void {
  for (const session of store.sessions) {
    if (session.archived) continue

    /*
     * A restart interrupts work rather than finishing it, and what it leaves behind is not nothing:
     * the conversation stops mid-task and a word from the user would put it back to work. These
     * come back saying that, rather than looking untouched — which is what they did when work in
     * flight was restored as idle.
     *
     * A graceful quit records the interruption on its way out; a crash does not, so a session still
     * marked as working is taken as interrupted too.
     */
    const inFlight = session.agentState === 'working' || session.agentState === 'delegating'
    const interrupted = inFlight || session.interruptedAt !== undefined
    if (interrupted && session.interruptedAt === undefined) {
      // Nothing recorded when it went down, so the last thing it did is the closest we have.
      store.updateSession(session.id, { interruptedAt: session.lastActivity })
    }

    const state = interrupted ? 'interrupted' : session.agentState
    if (state && state !== 'idle') agentStates.set(session.id, state)
    if (session.unseen || interrupted) unseen.add(session.id)
  }
  refreshBadge()
}

function isBeingWatched(sessionId: string): boolean {
  return store.activeSessionId === sessionId && BrowserWindow.getFocusedWindow() !== null
}

/** Dock badge counts everything wanting the user's eyes (PLAN.md §3.5). */
function refreshBadge(): void {
  const waiting = store.sessions.filter((s) => !s.archived && unseen.has(s.id)).length
  if (platformOf(process.platform) === 'mac' && app.dock) {
    app.dock.setBadge(waiting > 0 ? String(waiting) : '')
    return
  }
  /*
   * Linux has no dock API, but the Unity launcher protocol carries a count and the docks that
   * implement it (Dash to Dock, Plank, KDE's task manager) show it. Where nothing implements it
   * this is a no-op, which is the right outcome — better a badge that some desktops show than
   * none that any do.
   */
  app.setBadgeCount(waiting)
}

export function markSeen(sessionId: string): void {
  if (!unseen.delete(sessionId)) return
  if (store.session(sessionId)) store.updateSession(sessionId, { unseen: false })
  broadcast('agent:unseen', [...unseen])
  refreshBadge()
}

/**
 * Lets the title watcher rename a session without knowing about the store or the renderer. It fires
 * once per session, seconds after that session's first launch.
 */
export function wireAutoTitle(): void {
  titleWatcher.configure(applyGeneratedTitle, pushSessions)
}

export function wireAgentStates(): void {
  agentStates.on('state', (sessionId: string, { state, detail }: AgentStatus) => {
    const session = store.session(sessionId)
    if (session) store.updateSession(sessionId, { lastActivity: Date.now() })

    const isActive = isBeingWatched(sessionId)
    // The states that want the user are news; the ones where the agent has the ball are not.
    const wantsUser =
      state === 'done' || state === 'attention' || state === 'interrupted' || state === 'error'
    const isUnseen = wantsUser && !isActive
    if (isUnseen) unseen.add(sessionId)
    else if (state === 'working' || state === 'delegating') unseen.delete(sessionId)

    // A session can stop without anything having recorded why — a crash, a killed terminal — and
    // the launcher offers to carry on from an interruption, so it needs one noted.
    if (state === 'interrupted' && session && session.interruptedAt === undefined) {
      store.updateSession(sessionId, { interruptedAt: Date.now() })
    }

    // Persisted so a relaunch shows the same dots rather than resetting them all to idle. The
    // sub-agent name is not: nothing survives a relaunch still delegating.
    if (session) store.updateSession(sessionId, { agentState: state, unseen: unseen.has(sessionId) })

    broadcast('agent:state', { sessionId, state, detail, at: Date.now() })
    broadcast('agent:unseen', [...unseen])
    refreshBadge()

    if (!session) return

    if (!Notification.isSupported() || isActive) return

    if (state === 'attention') {
      new Notification({
        title: session.name,
        body: 'Claude needs your input',
        silent: false
      }).show()
    } else if (state === 'interrupted') {
      new Notification({ title: session.name, body: 'Claude stopped mid-task', silent: false }).show()
    } else if (state === 'error') {
      new Notification({
        title: session.name,
        body: 'An API error ended the turn',
        silent: false
      }).show()
    } else if (state === 'done') {
      new Notification({ title: session.name, body: 'Your turn', silent: true }).show()
    }
  })
}

/**
 * A session and the repo behind it — for the handlers that genuinely need git. A local session has
 * no repo, so this returns null for one, and those handlers decline exactly as they already did for
 * a session whose repo went missing.
 */
function requireSession(sessionId: string): { session: Session; repo: Repo } | null {
  const session = store.session(sessionId)
  if (!session) return null
  const repo = store.repo(session.repoId)
  if (!repo) return null
  return { session, repo }
}

/** For the handlers that only need a working directory: the terminals, the editor, the agent. */
function requireDirectory(sessionId: string): Session | null {
  return store.session(sessionId) ?? null
}

export function registerIpc(): void {
  ipcMain.handle('state:snapshot', async (): Promise<Snapshot> => {
    return {
      repos: store.repos,
      sessions: store.sessions,
      activeSessionId: store.activeSessionId,
      agentStates: agentStates.all(),
      worktreeRoot: worktreeRoot(),
      localRoot: localRoot(),
      home: app.getPath('home'),
      ghAvailable: await git.ghAvailable(),
      unseenSessions: [...unseen],
      profile: profile(),
      sourceLabel: sourceLabel(),
      preferences: store.preferences,
      theme: resolvedTheme(),
      appStartedAt: APP_STARTED_AT
    }
  })

  // ── preferences ─────────────────────────────────────────────────────────────
  /*
   * Answered synchronously, and read by the preload script before the page has run a line — the
   * one way the document can carry its theme into its very first paint.
   *
   * The obvious alternative does not work: nativeTheme.themeSource is set to the preference before
   * the window exists, but Chromium here still answers `prefers-color-scheme` from the OS, so a
   * dark preference on a light Mac reports light. themeSource is still set — the traffic lights and
   * the native dialogs do follow it — it simply cannot be what the stylesheet is told.
   */
  ipcMain.on('theme:current', (event) => {
    event.returnValue = resolvedTheme()
  })

  /*
   * Returns the merged result rather than nothing, so the renderer's copy comes from the store that
   * will actually be read at launch instead of from an optimistic guess about what the patch did.
   */
  ipcMain.handle(
    'preferences:update',
    async (_e, patch: Partial<Preferences>): Promise<Preferences> => {
      const preferences = store.updatePreferences(patch)
      // Recorded before anything repaints, so a theme that has to survive a relaunch is stored
      // whatever the repaint costs — and so the editor's settings are written before the renderer
      // is told to go and read them.
      if ('theme' in patch) await applyTheme()
      return preferences
    }
  )

  // ── repos ───────────────────────────────────────────────────────────────────
  ipcMain.handle('repo:add', async (): Promise<{ repo?: Repo; error?: string }> => {
    const result = await dialog.showOpenDialog({
      title: 'Add a repository',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Add repo'
    })
    if (result.canceled || result.filePaths.length === 0) return {}
    const added = await addRepo(result.filePaths[0])
    if ('error' in added) return { error: added.error }
    // A removed repo comes back with its sessions.
    pushSessions()
    return { repo: added }
  })

  ipcMain.handle('repo:update', (_e, id: string, patch: Partial<Repo>) => store.updateRepo(id, patch))

  /**
   * Whether a worktree cut from this ref would come with a setup script — the dialog's note promises
   * a new worktree runs one, and it must not promise that of a base whose tree has none.
   */
  ipcMain.handle('repo:setupScriptAt', async (_e, id: string, ref: string): Promise<boolean> => {
    const repo = store.repo(id)
    if (!repo) return false
    return git.pathExistsAtRef(repo.path, ref || repo.defaultBranch, SETUP_SCRIPT_REL)
  })

  ipcMain.handle('repo:removePlan', (_e, id: string) => removeRepoPlan(id))

  ipcMain.handle('repo:remove', async (_e, id: string, options: RemoveRepoOptions) => {
    const result = await removeRepo(id, options)
    pushSessions()
    refreshBadge()
    return result
  })

  // ── sessions ────────────────────────────────────────────────────────────────
  ipcMain.handle(
    'session:create',
    async (
      _e,
      repoId: string,
      name: string,
      base?: string,
      mode?: StartMode,
      launch?: LaunchSettings
    ) => {
      const result = await createSession(repoId, name, base, mode, launch)
      if (result.session) pushSessions()
      return result
    }
  )

  /** A folder to work in, with no repo behind it — made by Maestro unless a path is given. */
  ipcMain.handle(
    'session:createLocal',
    async (_e, text: string, path?: string, launch?: LaunchSettings) => {
      const result = await createLocalSession(text, path, launch)
      if (result.session) pushSessions()
      return result
    }
  )

  /**
   * The folder picker for that dialog. Separate from the dialog's text field on purpose: the field
   * is what makes the flow scriptable, and a native picker cannot be driven by a test.
   */
  ipcMain.handle('session:pickFolder', async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog({
      title: 'Open a folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open'
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return picked.filePaths[0]
  })

  /**
   * What a new session can start from: the default branch, then any in-flight session's branch,
   * then the repo's remaining local heads, then the remote branches it has no local copy of.
   *
   * Each carries the worktree that currently holds it, if any — that is what decides whether the
   * dialog may offer to continue on the branch rather than cut a new one from it. Read from git in
   * one pass rather than per branch: the answer for every ref is in a single `worktree list`.
   *
   * A remote branch whose local half already exists is left out rather than listed twice. The two
   * entries would mean subtly different things and the local one is what a session works on either
   * way, so offering both is a choice between a branch and its own shadow.
   */
  ipcMain.handle('session:baseOptions', async (_e, repoId: string): Promise<BaseOption[]> => {
    const repo = store.repo(repoId)
    if (!repo) return []

    const branches = await git.listBranches(repo.path)
    const sessions = store.sessions.filter((s) => s.repoId === repoId && !s.archived)
    const claimed = new Map(sessions.map((s) => [s.branch, s.name]))
    const held = new Map((await git.listWorktrees(repo.path)).map((w) => [w.branch, w.path]))

    const options: BaseOption[] = [
      {
        ref: repo.defaultBranch,
        kind: 'default',
        label: repo.defaultBranch,
        checkedOutAt: held.get(repo.defaultBranch) ?? null
      }
    ]

    for (const branch of branches) {
      if (branch === repo.defaultBranch) continue
      const sessionName = claimed.get(branch)
      const checkedOutAt = held.get(branch) ?? null
      options.push(
        sessionName
          ? { ref: branch, kind: 'session', label: sessionName, checkedOutAt }
          : { ref: branch, kind: 'branch', label: branch, checkedOutAt }
      )
    }

    const local = new Set(branches)
    for (const ref of await git.listRemoteBranches(repo.path)) {
      const name = git.localNameOf(ref)
      if (!name || local.has(name)) continue
      // Nothing can hold a remote-tracking ref, and the local branch it would become does not
      // exist yet — so continuing on it is always available.
      options.push({ ref, kind: 'remote', label: ref, checkedOutAt: null })
    }
    return options
  })

  /**
   * Refreshes remote-tracking refs so the base list can offer a branch pushed since the last fetch.
   * Called by the New session dialog on open rather than run on a timer: it is the one moment the
   * answer is about to be read, and it costs a network round trip.
   */
  ipcMain.handle('repo:fetch', async (_e, repoId: string): Promise<boolean> => {
    const repo = store.repo(repoId)
    if (!repo) return false
    return git.fetchRemotes(repo.path)
  })

  /** Existing worktrees of known repos that Maestro could adopt. */
  ipcMain.handle('session:importable', (): Promise<ImportableWorktree[]> => importableWorktrees())

  ipcMain.handle('session:import', async (_e, path: string) => {
    const result = await importWorktree(path)
    if (result.session) pushSessions()
    return result
  })

  ipcMain.handle('session:relocatePlan', (_e, path: string) => relocatePlan(path))

  /** Moves work off the primary clone into its own worktree, then adopts that. */
  ipcMain.handle('session:relocate', async (_e, path: string) => {
    const result = await relocateToWorktree(path)
    if (result.session) pushSessions()
    return result
  })

  /** Folder picker, for a worktree whose repo Maestro does not know yet. */
  ipcMain.handle('session:importPick', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import an existing worktree',
      properties: ['openDirectory'],
      buttonLabel: 'Import'
    })
    if (picked.canceled || picked.filePaths.length === 0) return {}
    const result = await importWorktree(picked.filePaths[0])
    if (result.session) pushSessions()
    return result
  })

  ipcMain.handle('session:setActive', (_e, id: string | null) => {
    store.setActiveSession(id)
    // Opening a session is what "seeing" it means.
    if (id) markSeen(id)
    return true
  })

  /*
   * The setup script for the repo this session belongs to, written into this worktree if the branch
   * does not carry one yet. The renderer opens the path it gets back in the session's own editor.
   *
   * A worktree is where it belongs: the script is a file in the repo, and this is the only kind of
   * place where editing a repo file leads somewhere — a branch, a commit, a merge back, and from
   * then on every clone of the repo has it.
   */
  ipcMain.handle(
    'session:setupScript',
    async (_e, id: string): Promise<{ path?: string; created?: boolean; error?: string }> => {
      const ctx = requireSession(id)
      if (!ctx) return { error: 'That session has no repo to set up.' }
      try {
        return await createSetupScript(ctx.session.worktreePath)
      } catch (err) {
        return { error: `Could not write the setup script: ${String(err)}` }
      }
    }
  )

  /** Whether this worktree carries a setup script — asked before offering to run one. */
  ipcMain.handle('session:hasSetupScript', async (_e, id: string): Promise<boolean> => {
    const session = store.session(id)
    return session ? (await setupScriptIn(session.worktreePath)) !== null : false
  })

  ipcMain.handle('session:archivePlan', (_e, id: string) => archivePlan(id))

  ipcMain.handle('session:dispose', async (_e, id: string, options: DisposeOptions) => {
    const result = await disposeSession(id, options)
    pushSessions()
    refreshBadge()
    return result
  })

  ipcMain.handle('local:folderPlan', (_e, dir: string) => localFolderPlan(dir))

  ipcMain.handle('local:deleteFolder', async (_e, dir: string, deleteFolder: boolean) => {
    const result = await deleteLocalFolder(dir, deleteFolder)
    pushSessions()
    refreshBadge()
    return result
  })

  ipcMain.handle('session:restore', async (_e, id: string) => {
    const result = await restoreSession(id)
    pushSessions()
    return result
  })

  ipcMain.handle('session:rename', (_e, id: string, name: string) => {
    // A name the user chose outranks the one Claude is about to suggest, so stop waiting for it.
    titleWatcher.cancel(id)
    const updated = store.updateSession(id, { name, awaitingTitle: undefined })
    pushSessions()
    return updated
  })

  // ── git ─────────────────────────────────────────────────────────────────────
  ipcMain.handle('git:status', async (_e, sessionId: string): Promise<GitStatus | null> => {
    const ctx = requireSession(sessionId)
    if (!ctx) return null
    try {
      return await git.status(ctx.session.worktreePath, ctx.repo.defaultBranch)
    } catch {
      return null
    }
  })

  ipcMain.handle('git:commits', async (_e, sessionId: string): Promise<Commit[]> => {
    const ctx = requireSession(sessionId)
    if (!ctx) return []
    return git.recentCommits(ctx.session.worktreePath, 8)
  })

  ipcMain.handle('git:remote', async (_e, sessionId: string): Promise<string | null> => {
    const ctx = requireSession(sessionId)
    if (!ctx) return null
    return git.parseRemote(await git.remoteUrl(ctx.session.worktreePath))
  })

  /**
   * Merge-back (PLAN.md §3.1, open question 2). Rebase is the default because it keeps the
   * session's history linear on top of main; conflicts stop the flow in place so they can be
   * opened in the embedded editor or handed to Claude, rather than being auto-resolved.
   */
  ipcMain.handle('git:merge', async (_e, input: MergeInput): Promise<MergeResult> => {
    const ctx = requireSession(input.sessionId)
    if (!ctx) return { ok: false, conflicts: [], message: 'Session not found.' }

    const integrated = await git.integrate(
      ctx.session.worktreePath,
      ctx.repo.defaultBranch,
      input.mode
    )
    if (!integrated.ok) {
      return { ok: false, conflicts: integrated.conflicts, message: integrated.message }
    }

    const landed = await git.landOnBase(ctx.repo.path, ctx.repo.defaultBranch, ctx.session.branch)
    if (!landed.ok) return { ok: false, conflicts: [], message: landed.message }

    if (input.archiveAfter) {
      // A merged session is genuinely finished, so this deletes rather than archives — the work is
      // on the base branch now, and there is nothing to come back to. The tree is clean at this
      // point (integrate() refuses otherwise), so no WIP handling is needed.
      await disposeSession(input.sessionId, {
        action: 'delete',
        wip: 'leave',
        deleteBranch: true,
        hardDelete: false,
        // A merged session's worktree and branch are Maestro's own by construction.
        allowForeign: false
      })
      pushSessions()
      refreshBadge()
    }
    return { ok: true, conflicts: [], message: '' }
  })

  ipcMain.handle('git:createPr', async (_e, input: PrInput): Promise<PrResult> => {
    const ctx = requireSession(input.sessionId)
    if (!ctx) return { ok: false, url: '', number: null, message: 'Session not found.' }
    return git.createPullRequest(
      ctx.session.worktreePath,
      ctx.session.branch,
      ctx.repo.defaultBranch,
      input.title,
      input.body
    )
  })

  ipcMain.handle('git:prStatus', async (_e, sessionId: string): Promise<PrStatus | null> => {
    const ctx = requireSession(sessionId)
    if (!ctx) return null
    return git.prStatus(ctx.session.worktreePath, ctx.session.branch)
  })

  // ── terminals ───────────────────────────────────────────────────────────────
  ipcMain.handle(
    'pty:claude',
    async (_e, sessionId: string, cols: number, rows: number, launch: ClaudeLaunch) => {
      const session = requireDirectory(sessionId)
      if (!session) return null

      /*
       * Reset before anything is awaited, because this says "a process is starting now" and that is
       * true at the moment the launch is asked for, not whenever the filesystem work below happens
       * to finish. Set after the awaits it was a race the machine decided: on a fast disk it landed
       * before the agent's first hook and looked correct, and on a slower one it landed after and
       * overwrote a live state with idle — a session that had gone to work came back saying nothing
       * was running, and the exit that followed then read as idle rather than as an interruption.
       *
       * An unread finish is the exception, on the same grounds `settle` keeps one: it is still the
       * answer the user has not looked at, and reopening the session is usually how they go to read
       * it. Everything else is genuinely superseded by the process about to start.
       */
      if (!(agentStates.get(sessionId) === 'done' && unseen.has(sessionId))) {
        agentStates.set(sessionId, 'idle')
      }

      // A conversation still running at the old path keeps growing there; pull it forward first,
      // so a relocated session resumes the current transcript rather than a snapshot.
      await syncRelocatedHistory(session)
      /*
       * Re-installed on every launch, not just at creation: a session made by an older Maestro
       * would otherwise never get the hooks added since, and would keep reporting a stale set.
       *
       * Never at the cost of the launch, though. A worktree this cannot be written to — read-only,
       * odd permissions, a full disk — would otherwise stop Claude from starting at all, and the
       * worst a missing hook can do is leave the dot less well informed.
       */
      try {
        await installHooks(session.worktreePath)
      } catch (err) {
        console.error('[maestro] could not install state hooks', err)
      }
      // Launching clears the interrupted marker — it has served its purpose.
      if (session.interruptedAt) store.updateSession(sessionId, { interruptedAt: undefined })

      /*
       * Only main can see whether there is anything to continue, so it settles the question here
       * rather than leaving the renderer to infer it. `claude --continue` in a directory with no
       * transcripts exits with "No conversation found", which the user would meet as a launcher
       * over an error — a worse answer than the new conversation they were going to get anyway.
       */
      let effective = launch
      if (effective.mode === 'continue' && !(await hasClaudeHistory(session.worktreePath))) {
        effective = { mode: 'new' }
      }

      /*
       * A brand new session carries the answer from the New session dialog, which becomes Claude's
       * opening message. It is consumed here rather than read inside launchClaude so it fires once:
       * a later relaunch, or a second conversation in the same worktree, starts from an empty
       * prompt instead of re-asking for work that is already done.
       */
      if (effective.mode === 'new') {
        const prompt = session.initialPrompt?.trim()
        if (prompt) {
          effective = { mode: 'new', prompt }
          store.updateSession(sessionId, { initialPrompt: undefined })
        }
      }

      // The opening message is also what Claude titles the conversation from, so this is the
      // moment the session's real name becomes obtainable. Watching is a no-op once it is named.
      if (session.awaitingTitle) titleWatcher.start(sessionId)

      return launchClaude(session, cols, rows, effective)
    }
  )

  /** Claude Code's stored conversations for this session's directory. */
  ipcMain.handle('claude:conversations', async (_e, sessionId: string): Promise<Conversation[]> => {
    const session = requireDirectory(sessionId)
    if (!session) return []
    await syncRelocatedHistory(session)
    return listConversations(session.worktreePath)
  })

  ipcMain.handle('pty:shell', (_e, sessionId: string, label: string, cols: number, rows: number) => {
    const session = requireDirectory(sessionId)
    if (!session) return null
    return ptys.spawnShell(sessionId, session.worktreePath, label, cols, rows)
  })

  ipcMain.handle('pty:setup', async (_e, sessionId: string, cols: number, rows: number) => {
    const ctx = requireSession(sessionId)
    if (!ctx) return null
    // Pushed twice, and both matter: once now for `running`, and again when the script exits — that
    // second push is what moves the footer off "setup running" and releases Claude's first turn.
    const handle = await runSetupScript(ctx.session, cols, rows, pushSessions)
    pushSessions()
    return handle
  })

  ipcMain.handle(
    'pty:script',
    (_e, sessionId: string, scriptId: string, cols: number, rows: number) => {
      const ctx = requireSession(sessionId)
      if (!ctx) return null
      const script = ctx.repo.runScripts.find((s) => s.id === scriptId)
      if (!script) return null
      return ptys.spawnScript(
        sessionId,
        ctx.session.worktreePath,
        script.name,
        script.command,
        cols,
        rows,
        { keepOpen: true }
      )
    }
  )

  /**
   * Typing to an agent counts as activity, which is what keeps a session from being flagged as
   * sleeping. Throttled, because this fires per keystroke and only the coarse time matters.
   */
  const lastTyped = new Map<string, number>()
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    ptys.write(id, data)
    const owner = ptys.ownerOf(id)
    if (!owner || owner.kind !== 'claude') return
    const now = Date.now()
    if (now - (lastTyped.get(owner.sessionId) ?? 0) < 60_000) return
    lastTyped.set(owner.sessionId, now)
    if (store.session(owner.sessionId)) {
      store.updateSession(owner.sessionId, { lastActivity: now })
      pushSessions()
    }
  })
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => ptys.kill(id))

  // ── editor ──────────────────────────────────────────────────────────────────
  ipcMain.handle(
    'editor:codeServer',
    async (_e, sessionId: string): Promise<CodeServerInfo & { folderUrl: string | null }> => {
      const session = requireDirectory(sessionId)
      if (!session) {
        return { available: false, url: null, reason: 'Session not found.', folderUrl: null }
      }
      const info = await codeServer.ensure()
      return { ...info, folderUrl: codeServer.folderUrl(session.worktreePath) }
    }
  )

  /** The escape hatch from PLAN.md §3.4 — hand the worktree or a file to the real VS Code. */
  ipcMain.handle('editor:openExternal', async (_e, path: string, line?: number) => {
    const target = line ? `vscode://file/${path}:${line}` : `vscode://file/${path}`
    try {
      await shell.openExternal(target)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('app:openPath', async (_e, path: string) => {
    const error = await shell.openPath(path)
    return { ok: !error, error }
  })

  ipcMain.handle('app:revealPath', (_e, path: string) => {
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle('app:basename', (_e, path: string) => basename(path))
}
