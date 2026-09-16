import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentStateEvent,
  AgentStatus,
  DisposeOptions,
  ArchivePlan,
  ArchiveResult,
  BaseOption,
  ClaudeLaunch,
  CodeServerInfo,
  Conversation,
  ImportableWorktree,
  LaunchSettings,
  RelocatePlan,
  RelocateResult,
  Commit,
  GitStatus,
  MergeInput,
  MergeResult,
  PrInput,
  PrResult,
  PrStatus,
  Preferences,
  Repo,
  Session,
  StartMode
} from '@shared/types'
import { platformOf } from '@shared/platform'
import type { ThemeName } from '@shared/theme'

export interface Snapshot {
  repos: Repo[]
  sessions: Session[]
  activeSessionId: string | null
  agentStates: Record<string, AgentStatus>
  worktreeRoot: string
  localRoot: string
  home: string
  ghAvailable: boolean
  unseenSessions: string[]
  profile: 'stable' | 'dev' | 'custom'
  sourceLabel: string
  preferences: Preferences
  theme: ThemeName
  appStartedAt: number
}

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
  signal: number | null
  /** Trailing output, so the renderer can tell why the process gave up. */
  tail: string
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /*
   * A plain value, not a call: the renderer needs it before its first paint — the sidebar reserves
   * space for macOS window controls that do not exist elsewhere — and anything asynchronous would
   * lay the shell out wrong for a frame first.
   */
  platform: platformOf(process.platform),

  /**
   * The resolved theme, read here rather than awaited in the renderer.
   *
   * This is the one value the document needs before it has rendered anything — a window that opens
   * on the wrong ground and corrects itself a frame later is a flash on every launch — and preload
   * runs before the page's own scripts, which makes a single synchronous round trip the cheapest
   * way to have the answer in time. Re-read on every document load, so a reload after a crash comes
   * back on the theme in force rather than the one this window was created with.
   */
  initialTheme: ipcRenderer.sendSync('theme:current') as ThemeName,
  snapshot: (): Promise<Snapshot> => ipcRenderer.invoke('state:snapshot'),
  onSessions: (cb: (sessions: Session[]) => void) => subscribe('state:sessions', cb),
  /**
   * The resolved theme, pushed whenever it changes — by the setting, or by the OS switching
   * appearance under a `system` preference.
   */
  onTheme: (cb: (theme: ThemeName) => void) => subscribe('state:theme', cb),

  preferences: {
    /** Patches one setting and answers with the whole of what is now stored. */
    update: (patch: Partial<Preferences>): Promise<Preferences> =>
      ipcRenderer.invoke('preferences:update', patch)
  },

  repos: {
    add: (): Promise<{ repo?: Repo; error?: string }> => ipcRenderer.invoke('repo:add'),
    update: (id: string, patch: Partial<Repo>): Promise<Repo | undefined> =>
      ipcRenderer.invoke('repo:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('repo:remove', id),
    /** Refreshes remote-tracking refs; false when there was no remote to reach. */
    fetch: (id: string): Promise<boolean> => ipcRenderer.invoke('repo:fetch', id),
    /** Whether a worktree cut from `ref` would carry `.maestro/setup.sh`. */
    setupScriptAt: (id: string, ref: string): Promise<boolean> =>
      ipcRenderer.invoke('repo:setupScriptAt', id, ref)
  },

  sessions: {
    /**
     * `mode` decides what happens to `base`: 'branch' (the default) cuts a new branch from it,
     * 'continue' checks that branch out in the session's worktree so commits land on it.
     */
    create: (
      repoId: string,
      name: string,
      base?: string,
      mode?: StartMode,
      launch?: LaunchSettings
    ): Promise<{ session?: Session; error?: string }> =>
      ipcRenderer.invoke('session:create', repoId, name, base, mode, launch),
    /**
     * Opens a plain folder — no repo, no worktree, no branch. Maestro creates the directory under
     * its own root unless `path` names one that already exists; `text` is the opening message for
     * a folder it creates, and a plain name for one that already exists.
     */
    createLocal: (
      text: string,
      path?: string,
      launch?: LaunchSettings
    ): Promise<{ session?: Session; error?: string }> =>
      ipcRenderer.invoke('session:createLocal', text, path, launch),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('session:pickFolder'),
    baseOptions: (repoId: string): Promise<BaseOption[]> =>
      ipcRenderer.invoke('session:baseOptions', repoId),
    importable: (): Promise<ImportableWorktree[]> => ipcRenderer.invoke('session:importable'),
    import: (path: string): Promise<{ session?: Session; error?: string }> =>
      ipcRenderer.invoke('session:import', path),
    relocatePlan: (path: string): Promise<RelocatePlan> =>
      ipcRenderer.invoke('session:relocatePlan', path),
    relocate: (path: string): Promise<RelocateResult> =>
      ipcRenderer.invoke('session:relocate', path),
    importPick: (): Promise<{ session?: Session; error?: string }> =>
      ipcRenderer.invoke('session:importPick'),
    setActive: (id: string | null): Promise<boolean> => ipcRenderer.invoke('session:setActive', id),
    /** Path of this worktree's `.maestro/setup.sh`, written from a template if it has none yet. */
    setupScript: (id: string): Promise<{ path?: string; created?: boolean; error?: string }> =>
      ipcRenderer.invoke('session:setupScript', id),
    /** Whether this worktree carries a setup script, without writing one. */
    hasSetupScript: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('session:hasSetupScript', id),
    archivePlan: (id: string): Promise<ArchivePlan | null> =>
      ipcRenderer.invoke('session:archivePlan', id),
    dispose: (id: string, options: DisposeOptions): Promise<ArchiveResult> =>
      ipcRenderer.invoke('session:dispose', id, options),
    restore: (id: string): Promise<ArchiveResult> => ipcRenderer.invoke('session:restore', id),
    rename: (id: string, name: string): Promise<Session | undefined> =>
      ipcRenderer.invoke('session:rename', id, name)
  },

  git: {
    status: (sessionId: string): Promise<GitStatus | null> =>
      ipcRenderer.invoke('git:status', sessionId),
    commits: (sessionId: string): Promise<Commit[]> => ipcRenderer.invoke('git:commits', sessionId),
    remote: (sessionId: string): Promise<string | null> =>
      ipcRenderer.invoke('git:remote', sessionId),
    merge: (input: MergeInput): Promise<MergeResult> => ipcRenderer.invoke('git:merge', input),
    createPr: (input: PrInput): Promise<PrResult> => ipcRenderer.invoke('git:createPr', input),
    prStatus: (sessionId: string): Promise<PrStatus | null> =>
      ipcRenderer.invoke('git:prStatus', sessionId)
  },

  pty: {
    claude: (
      sessionId: string,
      cols: number,
      rows: number,
      launch: ClaudeLaunch
    ): Promise<{ id: string } | null> =>
      ipcRenderer.invoke('pty:claude', sessionId, cols, rows, launch),
    shell: (
      sessionId: string,
      label: string,
      cols: number,
      rows: number
    ): Promise<{ id: string } | null> => ipcRenderer.invoke('pty:shell', sessionId, label, cols, rows),
    setup: (sessionId: string, cols: number, rows: number): Promise<{ id: string } | null> =>
      ipcRenderer.invoke('pty:setup', sessionId, cols, rows),
    script: (
      sessionId: string,
      scriptId: string,
      cols: number,
      rows: number
    ): Promise<{ id: string } | null> =>
      ipcRenderer.invoke('pty:script', sessionId, scriptId, cols, rows),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (cb: (e: PtyDataEvent) => void) => subscribe<PtyDataEvent>('pty:data', cb),
    onExit: (cb: (e: PtyExitEvent) => void) => subscribe<PtyExitEvent>('pty:exit', cb)
  },

  agent: {
    onState: (cb: (e: AgentStateEvent) => void) => subscribe<AgentStateEvent>('agent:state', cb),
    /** Sessions that finished or asked for input while the user was looking elsewhere. */
    onUnseen: (cb: (ids: string[]) => void) => subscribe<string[]>('agent:unseen', cb),
    conversations: (sessionId: string): Promise<Conversation[]> =>
      ipcRenderer.invoke('claude:conversations', sessionId)
  },

  editor: {
    codeServer: (sessionId: string): Promise<CodeServerInfo & { folderUrl: string | null }> =>
      ipcRenderer.invoke('editor:codeServer', sessionId),
    openExternal: (path: string, line?: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('editor:openExternal', path, line)
  },

  app: {
    openPath: (path: string): Promise<{ ok: boolean; error: string }> =>
      ipcRenderer.invoke('app:openPath', path),
    revealPath: (path: string): Promise<boolean> => ipcRenderer.invoke('app:revealPath', path),
    /** Reports an uncaught renderer error to main, which logs it to crash.log. */
    reportError: (message: string): void => ipcRenderer.send('app:renderer-error', message)
  }
}

export type MaestroApi = typeof api

contextBridge.exposeInMainWorld('maestro', api)
