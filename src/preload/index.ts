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
  BranchSync,
  GitStatus,
  MergeInput,
  MergeResult,
  PrInput,
  PrResult,
  PrStatus,
  Preferences,
  LocalFolderPlan,
  RemoveRepoOptions,
  RemoveRepoPlan,
  Repo,
  Session,
  StartMode,
  UpdateStatus
} from '@shared/types'
import { platformOf } from '@shared/platform'
import type { ThemeName } from '@shared/theme'
import type { Chord } from '@shared/shortcuts'

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
  /** Tabs whose terminal outlived the last window, as `<sessionId>:<tab key>`. */
  heldTerminals: string[]
  /** What the last window stashed about itself, keyed by what it stashed it under. */
  windowState: Record<string, unknown>
  /** How each session's tabs were last arranged, by session id. Survives a quit, unlike the stash. */
  arrangements: Record<string, unknown>
}

/** A terminal handed to a tab. `replay` and `exit` are set when it was already running before. */
export interface PtyAttach {
  id: string
  replay?: string
  exit?: { exitCode: number; tail: string }
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
  /**
   * Chords pressed inside the editor pane, which is a separate process and so has to hand them over.
   * Only the ones main intercepts arrive here; everything else stays the workbench's.
   */
  onShortcut: (cb: (chord: Chord) => void) => subscribe<Chord>('shortcut', cb),

  preferences: {
    /** Patches one setting and answers with the whole of what is now stored. */
    update: (patch: Partial<Preferences>): Promise<Preferences> =>
      ipcRenderer.invoke('preferences:update', patch)
  },

  repos: {
    add: (): Promise<{ repo?: Repo; error?: string }> => ipcRenderer.invoke('repo:add'),
    update: (id: string, patch: Partial<Repo>): Promise<Repo | undefined> =>
      ipcRenderer.invoke('repo:update', id, patch),
    /** The sidebar's order, top to bottom. */
    reorder: (ids: string[]): Promise<void> => ipcRenderer.invoke('repo:reorder', ids),
    /** What removing would do to each of the repo's sessions. */
    removePlan: (id: string): Promise<RemoveRepoPlan | null> =>
      ipcRenderer.invoke('repo:removePlan', id),
    /** Hides the repo and its sessions; deleting worktrees and branches is opt-in. */
    remove: (id: string, options: RemoveRepoOptions): Promise<ArchiveResult> =>
      ipcRenderer.invoke('repo:remove', id, options),
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
    /** What deleting a shared local folder's sessions would do. */
    folderPlan: (dir: string): Promise<LocalFolderPlan> => ipcRenderer.invoke('local:folderPlan', dir),
    /** Deletes every open session in the folder, and the folder itself when asked. */
    deleteFolder: (dir: string, deleteFolder: boolean): Promise<ArchiveResult> =>
      ipcRenderer.invoke('local:deleteFolder', dir, deleteFolder),
    restore: (id: string): Promise<ArchiveResult> => ipcRenderer.invoke('session:restore', id),
    rename: (id: string, name: string): Promise<Session | undefined> =>
      ipcRenderer.invoke('session:rename', id, name)
  },

  git: {
    status: (sessionId: string): Promise<GitStatus | null> =>
      ipcRenderer.invoke('git:status', sessionId),
    sync: (): Promise<Record<string, BranchSync>> => ipcRenderer.invoke('git:sync'),
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
    ): Promise<PtyAttach | null> => ipcRenderer.invoke('pty:claude', sessionId, cols, rows, launch),
    shell: (
      sessionId: string,
      tab: string,
      label: string,
      cols: number,
      rows: number
    ): Promise<PtyAttach | null> => ipcRenderer.invoke('pty:shell', sessionId, tab, label, cols, rows),
    setup: (sessionId: string, tab: string, cols: number, rows: number): Promise<PtyAttach | null> =>
      ipcRenderer.invoke('pty:setup', sessionId, tab, cols, rows),
    script: (
      sessionId: string,
      tab: string,
      scriptId: string,
      cols: number,
      rows: number
    ): Promise<PtyAttach | null> => ipcRenderer.invoke('pty:script', sessionId, tab, scriptId, cols, rows),
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

  ui: {
    /** Remembers something about this window for the next one; null forgets it. */
    stash: (key: string, value: unknown): void => ipcRenderer.send('ui:stash', key, value),
    /** Remembers how a session's tabs are arranged, across quits; null forgets it. */
    arrange: (sessionId: string, value: unknown): void =>
      ipcRenderer.send('ui:arrange', sessionId, value),
    /** A dialog is open. An update waits for it to close rather than reloading under it. */
    busy: (busy: boolean): void => ipcRenderer.send('ui:busy', busy)
  },

  app: {
    openPath: (path: string): Promise<{ ok: boolean; error: string }> =>
      ipcRenderer.invoke('app:openPath', path),
    revealPath: (path: string): Promise<boolean> => ipcRenderer.invoke('app:revealPath', path),
    /** Reports an uncaught renderer error to main, which logs it to crash.log. */
    reportError: (message: string): void => ipcRenderer.send('app:renderer-error', message)
  },

  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    onStatus: (cb: (status: UpdateStatus) => void) => subscribe<UpdateStatus>('update:status', cb),
    /** Does whatever the button currently offers: build and apply, apply, or restart. */
    press: (): void => ipcRenderer.send('update:press'),
    /** Stops a build before it publishes. */
    cancel: (): void => ipcRenderer.send('update:cancel'),
    openLog: (): void => ipcRenderer.send('update:log')
  }
}

export type MaestroApi = typeof api

// Before the page runs, so it lands ahead of any request the page makes for a terminal.
ipcRenderer.send('pty:window-loaded')

contextBridge.exposeInMainWorld('maestro', api)
