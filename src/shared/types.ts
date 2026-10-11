import type { ThemePreference } from './theme'

export type { ThemeName, ThemePreference } from './theme'

/**
 * What a session is up to, as the question is actually asked: is it busy, can I talk to it, does
 * it want something from me, and if so what kind of something.
 *
 * - `working` — Claude has the turn. Typing at it interrupts.
 * - `delegating` — a sub-agent is running and Claude's own turn has ended, so the work is in
 *   flight *and* the session will take a new prompt right now.
 * - `attention` — stopped on a question or a permission. It cannot go on without an answer.
 * - `done` — it finished what was asked and is waiting to be told what comes next. Not "over":
 *   the useful fact is that the turn is yours, not that anything is complete.
 * - `interrupted` — it stopped without finishing: killed, crashed, or cut off by a restart. A
 *   word from the user would put it back to work.
 * - `error` — an API error ended the turn: a rate limit, an expired login, an overloaded model.
 *   The session is alive and the work is not done, and which error it was decides what to do.
 * - `idle` — nothing running here, ready if wanted.
 */
export type AgentState =
  | 'working'
  | 'delegating'
  | 'attention'
  | 'done'
  | 'interrupted'
  | 'error'
  | 'idle'

/** A state plus, when there is one, the word that says which — sub-agent or error. */
export interface AgentStatus {
  state: AgentState
  /**
   * Sub-agent name — "code-review", "Explore" — while one is running, and the API error's kind —
   * "rate_limit", "authentication_failed" — on {@link AgentState} `error`. Absent otherwise.
   */
  detail?: string
}

export interface RunScript {
  id: string
  name: string
  command: string
}

export interface Repo {
  id: string
  /** Display name — the repo directory's basename. */
  name: string
  /** Absolute path to the primary clone. */
  path: string
  defaultBranch: string
  runScripts: RunScript[]
  collapsed: boolean
  /**
   * Removed from Maestro. The record and its sessions are kept out of sight rather than dropped, so
   * adding the same path again brings them back as they were.
   */
  hidden?: boolean
}

/**
 * How far this session's worktree has got through the repo's `.maestro/setup.sh`. `ok` also covers
 * the sessions that never had one to run — a worktree with nothing to build is a built worktree.
 */
export type SetupState = 'pending' | 'running' | 'ok' | 'failed'

/**
 * The group local sessions belong to — a folder to run Claude in, with no repo behind it.
 *
 * They carry this sentinel rather than a nullable repoId. No entry in `store.repos` can ever have
 * it, so "look up this session's repo" comes back empty — which every caller already has to handle
 * — instead of every caller having to learn about a second shape of session.
 */
export const LOCAL_REPO_ID = 'local'

/** A session that is only a directory: no worktree, no branch, no repo. */
export function isLocal(session: Pick<Session, 'repoId'>): boolean {
  return session.repoId === LOCAL_REPO_ID
}

export interface Session {
  id: string
  /** {@link LOCAL_REPO_ID} for a local session — see {@link isLocal}. */
  repoId: string
  /** What the user typed — "fix verdict pagination". */
  name: string
  /** feature/<slug>, empty for a local session. */
  branch: string
  /** The session's working directory. A worktree, or the folder itself when local. */
  worktreePath: string
  createdAt: number
  lastActivity: number
  archived: boolean
  setupState: SetupState
  /**
   * The setup script said `# maestro: background`, so nothing waits for it — Claude takes its first
   * turn and run scripts start while it is still going.
   *
   * Recorded on the session rather than read from the file when needed, because the file is the
   * worktree's own and a branch may edit it: what this run of setup was told is a fact about the
   * run, not about the file as it stands now.
   */
  setupBackground?: boolean

  /*
   * Ownership, recorded as three independent facts rather than one "adopted" flag.
   *
   * A single boolean conflated things that genuinely differ: who created the worktree, who
   * created the branch, and whether the worktree is even removable. Archive policy is derived
   * from these, so a worktree the user made by hand — or the primary clone — needs no special
   * case; it simply does not satisfy the preconditions.
   */

  /**
   * Maestro created this working directory, so Maestro may remove it — with one exception: a local
   * session's folder has no branch behind it, so nothing could be restored from, and it is kept
   * whatever this says.
   */
  worktreeOwned: boolean
  /** Maestro created this branch, so Maestro may delete it. */
  branchOwned: boolean
  /** git refuses to remove a primary working tree, whoever owns it. */
  isPrimaryClone: boolean

  /** Directory this worktree was moved out of, so its conversation history can be kept in sync. */
  relocatedFrom?: string
  /**
   * Which model this session's Claude runs on, and how hard it thinks. Kept rather than consumed,
   * so every relaunch of this session starts the same way the first one did. Both are set only
   * when the user chose them; absent, no flag is passed at all.
   */
  model?: ClaudeModel
  effort?: EffortLevel
  /**
   * What the user answered in the New session dialog, waiting to be sent to Claude as the opening
   * message of its first conversation. Consumed on that launch and then cleared, so relaunching or
   * starting a second conversation in this worktree begins clean rather than re-asking for work
   * that is already underway.
   */
  initialPrompt?: string
  /**
   * Set while this session still answers to the random handle it was created with, waiting for
   * Claude to title its first conversation. Cleared once named, so a second conversation in the
   * same worktree never renames the session out from under the user.
   */
  awaitingTitle?: boolean
  /**
   * When Claude was killed here while it was still working — app quit, crash, forced close.
   * Persisted so the next launch can say so, instead of silently resuming a transcript that
   * stops mid-sentence.
   */
  interruptedAt?: number

  /**
   * Last known agent state and whether its result is still unlooked-at. Held in memory the state
   * would reset to idle on every relaunch, so a finished session came back looking untouched and
   * the completion it was reporting was lost.
   */
  agentState?: AgentState
  unseen?: boolean

  /** When the session was archived, for ordering the archived list. */
  archivedAt?: number
  /**
   * When the session was last brought back from the archive.
   *
   * A session has a conversation to continue if it predates this app launch — but that is not true
   * of one archived and restored inside a single run, which has a whole life behind it and a
   * `createdAt` from minutes ago. Restoring such a session used to open a brand new conversation
   * over the work the user had just asked for back. This is the fact the age test cannot see.
   */
  restoredAt?: number
  /**
   * Commit of a stash taken when archiving, so restoring can put the uncommitted work back.
   * Stashes live in the repo's common git dir, so they outlive the worktree they came from.
   */
  archivedStash?: string
}

/**
 * Archiving and deleting differ in what survives, not in how forceful they are.
 *
 * archive — the worktree directory goes, the branch and the session record stay. Reversible:
 *   restore recreates the worktree from the branch and puts back any stash it took.
 * delete  — the record goes, and optionally the branch. Nothing to come back to.
 */
export type DisposeAction = 'archive' | 'delete'

/** What to do with uncommitted work before the worktree is removed. */
export type WipPlan = 'commit' | 'stash' | 'discard' | 'leave'

/** What deleting a shared local folder's sessions would do, for its dialog. */
export interface LocalFolderPlan {
  path: string
  /** Open sessions in the folder — the ones the sidebar groups under it. */
  sessionIds: string[]
  /** Archived ones there too, which only go if the folder does: nothing would be left to restore. */
  archivedIds: string[]
  canDeleteFolder: boolean
  /** Why the folder cannot be deleted, when it cannot. */
  folderRefusal?: string
  /** Every session there was opened on a folder Maestro made. */
  madeByMaestro: boolean
}

/** What deleting a repo's own folder would take with it. */
export interface RepoFolderPlan {
  path: string
  canDelete: boolean
  /** Why it cannot be deleted, when it cannot. */
  refusal?: string
  /** Commits on local branches that no remote has. */
  unpushedCommits: number
  stashes: number
  /** Uncommitted files in the clone itself; worktrees count their own in their session plans. */
  dirtyFiles: number
}

export interface RemoveRepoPlan {
  sessions: ArchivePlan[]
  folder: RepoFolderPlan
}

/**
 * What else goes when a repo is removed. Without `deleteFolder` the repo is only hidden; with it,
 * the clone, every session's worktree and every session record go, and nothing can come back.
 */
export interface RemoveRepoOptions {
  /** Worktrees Maestro created, plus foreign ones when `allowForeign` is set. */
  removeWorktrees: boolean
  /** Branches Maestro created, whose worktree is removed or already gone. Never a foreign branch. */
  deleteBranches: boolean
  wip: WipPlan
  allowForeign: boolean
  deleteFolder: boolean
}

export interface DisposeOptions {
  action: DisposeAction
  wip: WipPlan
  deleteBranch: boolean
  /**
   * Permits removing a worktree or branch Maestro did not create. Off by default and warned about,
   * because it destroys something the user made by hand rather than something Maestro can rebuild —
   * but refusing outright was more paternalistic than useful.
   */
  allowForeign: boolean
  /**
   * If `git worktree remove` still fails, fall back to `rm -rf` on the worktree. Opt-in only:
   * this used to run automatically on any failure, which turned a refusal into destruction.
   */
  hardDelete: boolean
  /** Deletes a local session's folder along with it. Delete only, never archive. */
  deleteFolder?: boolean
}

/**
 * What archiving or deleting this session would actually do — computed in main so the
 * confirmation dialog states facts rather than guessing.
 */
export interface ArchivePlan {
  sessionId: string
  worktreePath: string
  branch: string
  /** Whether each destructive step is permitted at all for this session. */
  canRemoveWorktree: boolean
  canDeleteBranch: boolean
  /** Permitted only with allowForeign, and warned about — Maestro did not create these. */
  worktreeIsForeign: boolean
  branchIsForeign: boolean
  isPrimaryClone: boolean
  worktreeOwned: boolean
  branchOwned: boolean
  /** A local session: no worktree or branch, just a folder. */
  isLocal: boolean
  /**
   * A local session's folder may be deleted on request. False for anything that would take more
   * than this session's own files with it — see {@link folderRefusal}.
   */
  canDeleteFolder: boolean
  /** Why the folder cannot be deleted, when it cannot. */
  folderRefusal?: string
  /**
   * The session is already archived, so archiving again is not on offer — only delete is, and it
   * acts on what archiving left behind.
   */
  archived: boolean
  /**
   * The working directory is not on disk any more — usually because archiving removed it. There is
   * nothing to remove, and nothing holding the branch either.
   */
  worktreeGone: boolean
  /** Uncommitted files that removal would destroy. */
  dirtyCount: number
  /** Reasons a step is unavailable, shown verbatim. */
  notes: string[]
  /** Whether archiving can be undone for this session — false when the worktree is not ours. */
  restorable: boolean
  /**
   * The stash archiving took, if it took one. Delete leaves it in the repo's stash list rather than
   * dropping it, so the dialog says where the work went.
   */
  archivedStash?: string
}

export interface ArchiveResult {
  ok: boolean
  error?: string
  /** Commands that ran, for the record. */
  commands: string[]
}

/** An existing worktree that Maestro could adopt, as offered by the Import dialog. */
export interface ImportableWorktree {
  path: string
  branch: string
  /** Uncommitted file count, so the user can see WIP is coming along. */
  dirtyCount: number
  /** Whether Claude Code has conversation history for this directory. */
  hasHistory: boolean
  /** Repo this worktree belongs to, if that repo is already known to Maestro. */
  repoId: string | null
  repoName: string
  /** The repo's primary clone — working here ties up the clone every other session shares. */
  isPrimaryClone: boolean
  /**
   * True when the work here can be moved into its own worktree, freeing the primary clone.
   * False when it is already sitting on the base branch, where there is nothing to move.
   */
  canRelocate: boolean
  /** Branch the primary clone would return to after relocating. */
  defaultBranch: string
}

/**
 * Exactly what relocating would run, computed by the code that runs it — so the dialog never
 * shows a placeholder path or a command that differs from reality.
 */
export interface RelocatePlan {
  primaryPath: string
  /** Absolute path of the worktree that will be created. */
  worktreePath: string
  branch: string
  defaultBranch: string
  dirtyCount: number
  hasHistory: boolean
  /** Commands grouped by the directory they run in, in order. */
  steps: { cwd: string; commands: string[] }[]
  /** Set when relocation is impossible; steps is then empty. */
  blocked: string | null
  /**
   * True when Maestro itself is running out of this directory. Switching the clone to its base
   * branch deletes the source the running instance was launched from, which kills the dev server
   * mid-operation — the move still completes, but the app performing it pulls its own files away.
   */
  selfHosted: boolean
}

export interface RelocateResult {
  session?: Session
  error?: string
  /** Commands that ran, for the record. */
  commands: string[]
}

export type ChangeKind = 'M' | 'A' | 'D' | 'R' | '?'

export interface ChangedFile {
  /** Repo-relative path. */
  path: string
  /** Basename. */
  name: string
  /** Directory portion, '' at the root. */
  dir: string
  kind: ChangeKind
  insertions: number
  deletions: number
}

export interface Commit {
  hash: string
  subject: string
}

/** Some of a session's work is on the base branch — merged there by Maestro, Claude or anyone. */
export interface Landing {
  /** `remote` once it is on origin's base branch; `local` while only the local one has it. */
  where: 'remote' | 'local'
  /** The ref it landed on — `origin/main` or `main` — for saying so. */
  ref: string
  /** Commits on the branch since that the base does not have yet. */
  commitsAfter: number
  /** Uncommitted files in the worktree. */
  filesAfter: number
}

/** The sidebar's view of a session's branch: how far ahead it is, or where it landed. */
export interface BranchSync {
  ahead: number
  landing: Landing | null
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  files: ChangedFile[]
  insertions: number
  deletions: number
  landing: Landing | null
}

/** One of Claude Code's stored conversations for a worktree. */
export interface Conversation {
  /** Claude Code session id — what `claude --resume <id>` takes. */
  id: string
  /** The name given to the session, empty when it was never titled. */
  title: string
  lastPrompt: string
  updatedAt: number
  messages: number
  /** Written to very recently, so another Claude probably still holds it open. */
  live: boolean
}

/**
 * What `claude --permission-mode` takes. `auto` is the one this exists for — Claude approves its
 * own tool use instead of stopping at every prompt — but the flag is modelled in full rather than
 * as a boolean, so widening the setting later is a UI change and not a data migration.
 */
export type PermissionMode =
  | 'auto'
  | 'acceptEdits'
  | 'plan'
  | 'manual'
  | 'dontAsk'
  | 'bypassPermissions'

/**
 * What `claude --model` takes. Aliases rather than full model ids, so a session follows whatever
 * the alias points at as models change instead of pinning a name that will be retired.
 */
export type ClaudeModel = 'opus' | 'opus[1m]' | 'opusplan' | 'sonnet' | 'sonnet[1m]' | 'haiku'

/** What `claude --effort` takes: how hard Claude thinks before it answers. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * The flags a session's Claude starts with, chosen when the session is created. Undefined passes
 * no flag at all, which is not the same as naming the default: it leaves Claude Code's own
 * configuration in charge.
 */
export interface LaunchSettings {
  model?: ClaudeModel
  effort?: EffortLevel
}

/** Settings the user chooses for the app itself, not for one repo or one session. */
export interface Preferences {
  /**
   * Which ground the whole app sits on — shell, terminal and embedded editor alike. Undefined
   * means dark, the theme this was designed on: an app that has only ever been dark should not
   * change appearance because a setting it never had grew a default. `system` is opt-in.
   */
  theme?: ThemePreference
  /**
   * The mode every Claude Maestro launches starts in. Undefined passes no flag at all, so Claude's
   * own default — and any `defaultMode` in the user's `.claude/settings.json` — still decides. That
   * is deliberately different from naming a mode explicitly, which would override those.
   */
  permissionMode?: PermissionMode
  /**
   * Whether a session reaching a state that wants the user makes a sound. Off unless asked for:
   * several sessions finishing while Maestro sits behind another window is the normal case, and a
   * noise nobody opted into is one the user has to go find the setting for.
   */
  chime?: boolean
  /**
   * Whether Maestro fetches its own repository while it runs, so an update that landed on the
   * remote is offered without anyone pulling first. Off unless asked for: it talks to the network
   * on a timer, and a repository whose `main` only moves locally gains nothing from it.
   */
  remoteUpdates?: boolean
  /**
   * Whether the update button skips the test suite and only builds `main`. Off unless asked for:
   * the tests are what stop a broken `main` from replacing a working app, and turning them off
   * trusts that `main` was tested before it merged.
   */
  skipUpdateTests?: boolean
}

/**
 * How to launch Claude. Resuming by explicit id is preferred over --continue, which cannot be
 * pointed at a particular conversation and declines any that is still held open elsewhere.
 */
export type ClaudeLaunch =
  | {
      mode: 'new'
      /**
       * Opening message, submitted as Claude's first turn. Filled in by main from the session's
       * pending `initialPrompt`; the renderer never sets it.
       */
      prompt?: string
    }
  | { mode: 'continue' }
  | { mode: 'resume'; conversationId: string; fork: boolean }

export type PtyKind = 'claude' | 'shell' | 'script'

export interface PtyHandle {
  id: string
  sessionId: string
  kind: PtyKind
  label: string
}

/**
 * What a new session does with the branch it was pointed at.
 *
 * - `branch` — cuts a new branch from it, the default. The base is left exactly as it was.
 * - `continue` — checks the branch itself out in the session's worktree, so commits land on it.
 *   Only possible while no other worktree holds the branch, since git allows one checkout per ref.
 */
export type StartMode = 'branch' | 'continue'

export interface CreateSessionInput {
  repoId: string
  name: string
  /** Git ref the worktree is cut from. Defaults to the repo's default branch. */
  base?: string
  /** Defaults to `branch`. */
  mode?: StartMode
}

/** A branch a new session can be started from, as offered by the New session dialog. */
export interface BaseOption {
  /** The git ref to start from — `fix-login` for a local branch, `origin/fix-login` for a remote one. */
  ref: string
  /** `remote` is a branch this clone has no local copy of; continuing on one creates that copy. */
  kind: 'default' | 'session' | 'branch' | 'remote'
  /** Session name when kind is 'session', otherwise the ref itself. */
  label: string
  /**
   * The worktree already holding this ref, if any — the primary clone for the default branch, a
   * session's worktree for one in flight. Non-null means the branch cannot be continued on, only
   * branched from.
   */
  checkedOutAt: string | null
}

export type MergeMode = 'rebase' | 'merge'

export interface MergeInput {
  sessionId: string
  mode: MergeMode
  archiveAfter: boolean
}

export interface MergeResult {
  ok: boolean
  /** Repo-relative paths left conflicted, when ok is false. */
  conflicts: string[]
  message: string
}

export interface PrInput {
  sessionId: string
  title: string
  body: string
}

export interface PrResult {
  ok: boolean
  url: string
  number: number | null
  message: string
}

export type CheckState = 'pending' | 'passed' | 'failed' | 'none'

export interface PrStatus {
  number: number | null
  url: string
  checks: { name: string; state: CheckState }[]
}

export interface AgentStateEvent extends AgentStatus {
  sessionId: string
  at: number
}

export interface EditorTarget {
  /** Absolute path to a file or a directory. */
  path: string
  line?: number
}

export interface CodeServerInfo {
  available: boolean
  url: string | null
  /** Human-readable reason when unavailable. */
  reason: string
}

/** How far an update's test run has got, read from Playwright's output as it goes. */
export interface TestProgress {
  done: number
  total: number
  /** Estimated from the pace so far; null until the first test finishes. */
  leftSeconds: number | null
}

/**
 * Whether there is a newer Maestro to switch to, and where getting it has got to. Shown as the
 * update button; nothing is applied until it is pressed.
 */
export type UpdateStatus =
  | { state: 'none' }
  /** `main` has commits the running build does not. Pressing builds, tests and applies them. */
  | { state: 'available'; changes: number; subject: string }
  /** A tested build is published and waiting. Pressing applies it. */
  | { state: 'ready'; subject: string }
  | { state: 'building'; step: 'build' | 'test' | 'publish'; tests?: TestProgress }
  | { state: 'applying' }
  | { state: 'failed'; message: string }
  /** The build needs a new terminal host, which only a real restart can bring. */
  | { state: 'restart'; subject: string }
