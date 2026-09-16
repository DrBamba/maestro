import { homedir } from 'node:os'
import { join, basename, resolve as resolvePath } from 'node:path'
import { rm, access, cp, readdir, mkdir, stat, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type {
  ArchivePlan,
  ArchiveResult,
  ClaudeLaunch,
  DisposeOptions,
  LaunchSettings,
  WipPlan,
  ImportableWorktree,
  RelocatePlan,
  RelocateResult,
  LocalFolderPlan,
  RemoveRepoOptions,
  RemoveRepoPlan,
  RepoFolderPlan,
  Repo,
  Session,
  StartMode
} from '@shared/types'
import { LOCAL_REPO_ID, isLocal } from '@shared/types'
import { removalStep } from '@shared/removeRepo'
import { store } from './store'
import * as git from './git'
import { agentStates, installHooks, stateFileFor, STATE_FILE_ENV } from './agentState'
import { ptys } from './pty'
import { resolveBinary } from './shellEnv'
import { profile } from './profile'
import { randomHandle } from './handles'
import { newestConversation } from './claudeHistory'
import { titleWatcher } from './autoTitle'
import { isBackground, setupCommand, setupScriptIn } from './setupScript'
import { syncSharedFolderNote } from './sharedFolder'

/**
 * PLAN.md open question 5 — worktree location convention. Worktrees live outside the repo, at
 * ~/maestro/<repo>/<slug>, so they never pollute the primary clone's directory and the path is
 * predictable enough to show in the session footer.
 *
 * A non-stable profile gets its own root. Profile isolation covers app state, not the filesystem,
 * and worktrees are the part of Maestro that writes to real directories — keeping dev's under
 * ~/maestro-dev means a session created while testing cannot land among real ones.
 */
export function worktreeRoot(): string {
  /*
   * Overridable so an automated run gets a throwaway root. Without it the e2e suite wrote into the
   * shared ~/maestro-dev, where a previous run's directory collided with the next and the
   * uniquifier quietly renamed the branch — tests were not isolated from each other, and each run
   * left worktrees behind.
   */
  const override = process.env.MAESTRO_WORKTREE_ROOT
  if (override) return override
  return join(homedir(), profile() === 'stable' ? 'maestro' : 'maestro-dev')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The directory- and branch-safe form of a name — "Fix the verdict list" → "fix-the-verdict-list". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'session'
}

/**
 * Where Maestro puts the folders it makes for local sessions: beside the worktrees it makes, under
 * the same root, so everything the app created lives in one place a user can inspect or delete.
 */
export function localRoot(): string {
  return join(worktreeRoot(), 'local')
}

/**
 * Claude Code keys conversation history by the absolute working directory, with separators
 * flattened to dashes: /Users/x/repos/foo -> -Users-x-repos-foo.
 *
 * This is why adopting a worktree happens **in place**. Relocating it would change the key, and
 * `claude --continue` would find no history — the conversation the user wants back would be
 * orphaned in the old directory.
 */
export function claudeHistoryDirs(worktreePath: string): string[] {
  // CLAUDE_CONFIG_DIR moves the whole ~/.claude tree, transcripts included — set by anyone running
  // several accounts side by side, and by this app's own test suite.
  const root = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  const base = join(root, 'projects')
  const flat = worktreePath.replace(/\//g, '-')
  return [join(base, flat), join(base, flat.replace(/\./g, '-'))]
}

/**
 * Whether there is a conversation here to pick up.
 *
 * A transcript, not a directory: Claude creates the project directory when it starts, so its
 * existence says only that the agent once ran here. `--continue` needs something to continue, and
 * answers "No conversation found" for a directory holding no transcripts.
 */
export async function hasClaudeHistory(worktreePath: string): Promise<boolean> {
  for (const dir of claudeHistoryDirs(worktreePath)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      // Try the next encoding variant.
      continue
    }
    if (names.some((name) => name.endsWith('.jsonl'))) return true
  }
  return false
}

/**
 * Copies Claude Code's conversation history from one directory's key to another's, so relocating
 * a worktree keeps its conversations. Verified: a copied transcript resumes correctly at the new
 * path even though the `cwd` recorded inside it still points at the old one.
 */
async function copyClaudeHistory(fromPath: string, toPath: string): Promise<boolean> {
  // The real encoding flattens both separators and dots, so prefer that destination variant.
  const destinations = claudeHistoryDirs(toPath)
  const dest = destinations[destinations.length - 1]
  for (const source of claudeHistoryDirs(fromPath)) {
    try {
      await access(source)
    } catch {
      continue
    }
    try {
      // preserveTimestamps keeps the files' own recency; without it every copy is stamped with
      // the copy time, in no particular order.
      await cp(source, dest, { recursive: true, force: true, preserveTimestamps: true })
      return true
    } catch (err) {
      console.error('[sessions] history copy failed', err)
      return false
    }
  }
  return false
}

/**
 * Brings a relocated session's conversation history up to date from the directory it was moved
 * out of. A conversation that was still running when the worktree moved keeps being written at
 * the old path, so the copy taken during the move is only a snapshot.
 *
 * Files are copied individually and only when the source is genuinely newer, so work done in the
 * new worktree is never overwritten by a stale original.
 */
export async function syncRelocatedHistory(session: Session): Promise<void> {
  if (!session.relocatedFrom) return

  const destinations = claudeHistoryDirs(session.worktreePath)
  const dest = destinations[destinations.length - 1]

  for (const source of claudeHistoryDirs(session.relocatedFrom)) {
    let names: string[]
    try {
      names = await readdir(source)
    } catch {
      continue
    }
    await mkdir(dest, { recursive: true })

    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const from = join(source, name)
      const to = join(dest, name)
      try {
        const [srcStat, dstStat] = await Promise.all([
          stat(from),
          stat(to).catch(() => null)
        ])
        /*
         * Transcripts are append-only, so byte size is a monotonic measure of how much
         * conversation a file holds — and unlike mtime it cannot be falsified by a past copy that
         * restamped the destination. Size decides; mtime only breaks ties.
         */
        if (dstStat) {
          if (dstStat.size > srcStat.size) continue
          if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) continue
        }
        await cp(from, to, { force: true, preserveTimestamps: true })
      } catch (err) {
        console.error('[sessions] history sync failed for', name, err)
      }
    }
    return
  }
}

/** Worktrees of known repos that Maestro is not already tracking, primary clones included. */
export async function importableWorktrees(): Promise<ImportableWorktree[]> {
  const tracked = new Set(store.sessions.filter((s) => !s.archived).map((s) => s.worktreePath))
  const out: ImportableWorktree[] = []

  for (const repo of store.repos) {
    for (const entry of await git.listWorktrees(repo.path)) {
      if (tracked.has(entry.path)) continue
      out.push({
        path: entry.path,
        branch: entry.branch,
        dirtyCount: await git.dirtyCount(entry.path),
        hasHistory: await hasClaudeHistory(entry.path),
        repoId: repo.id,
        repoName: repo.name,
        isPrimaryClone: entry.isMain,
        // Nothing to move if the clone is already on the base branch; and the base cannot be
        // checked out in two places, so it could not become a worktree anyway.
        canRelocate: entry.isMain && entry.branch !== repo.defaultBranch,
        defaultBranch: repo.defaultBranch
      })
    }
  }
  return out
}

/**
 * Whether Maestro is running out of this directory. In development app.getAppPath() is the
 * project root; packaged it is inside the .app bundle, which can never sit in a user's repo.
 *
 * Relocating such a clone still succeeds, but the clone must end up on its base branch, and that
 * necessarily removes the feature branch's files — including the source the running instance was
 * launched from. No ordering avoids it, so the UI warns instead of pretending otherwise.
 */
function isSelfHosted(worktreePath: string): boolean {
  const appPath = app.getAppPath()
  return appPath === worktreePath || appPath.startsWith(`${worktreePath}/`)
}

interface Relocation {
  repo: Repo
  branch: string
  worktreePath: string
  dirtyCount: number
}

/** Shared by the plan and the execution, so what the dialog shows is what actually runs. */
async function computeRelocation(path: string): Promise<Relocation | { error: string }> {
  const root = await git.repoRoot(path)
  if (!root) return { error: `${path} is not a git repository.` }

  const main = await git.mainRepoPath(root)
  if (main !== root) {
    return { error: 'That worktree is not the primary clone; import it in place instead.' }
  }
  if (await git.isDetached(root)) {
    return { error: 'The primary clone is on a detached HEAD; check out a branch first.' }
  }

  let repo = store.repos.find((r) => r.path === root)
  if (!repo) {
    const added = await addRepo(root)
    if ('error' in added) return { error: added.error }
    repo = added
  }

  const branch = await git.currentBranch(root)
  if (branch === repo.defaultBranch) {
    return {
      error: `Already on ${repo.defaultBranch} — nothing to move.`
    }
  }

  const slug = slugify(branch.replace(/^maestro\//, ''))
  let suffix = 1
  let worktreePath = join(worktreeRoot(), repo.name, slug)
  while (await pathExists(worktreePath)) {
    suffix += 1
    worktreePath = join(worktreeRoot(), repo.name, `${slug}-${suffix}`)
  }

  return { repo, branch, worktreePath, dirtyCount: await git.dirtyCount(root) }
}

export async function relocatePlan(path: string): Promise<RelocatePlan> {
  const computed = await computeRelocation(path)
  const root = (await git.repoRoot(path)) ?? path

  if ('error' in computed) {
    return {
      primaryPath: root,
      worktreePath: '',
      branch: await git.currentBranch(root),
      defaultBranch: '',
      dirtyCount: await git.dirtyCount(root),
      hasHistory: await hasClaudeHistory(root),
      steps: [],
      blocked: computed.error,
      selfHosted: isSelfHosted(root)
    }
  }

  const { repo, branch, worktreePath, dirtyCount } = computed
  const steps: RelocatePlan['steps'] = [
    {
      cwd: root,
      commands: [
        'git checkout --detach',
        `git worktree add ${worktreePath} ${branch}`,
        ...(dirtyCount > 0 ? ['git stash push -u -m "maestro: moving to a worktree"'] : [])
      ]
    }
  ]
  if (dirtyCount > 0) steps.push({ cwd: worktreePath, commands: ['git stash pop'] })
  steps.push({ cwd: root, commands: [`git checkout ${repo.defaultBranch}`] })

  return {
    primaryPath: root,
    worktreePath,
    branch,
    defaultBranch: repo.defaultBranch,
    dirtyCount,
    hasHistory: await hasClaudeHistory(root),
    steps,
    blocked: null,
    selfHosted: isSelfHosted(root)
  }
}

/**
 * Moves the work sitting on a repo's primary clone into its own worktree, leaving the clone back
 * on its base branch.
 *
 * A branch cannot be checked out twice, so the clone has to let go of it before the worktree can
 * take it — but it lets go by detaching HEAD, not by switching branch. Detaching leaves the
 * working tree byte-identical, so the worktree is created while the files are still intact, and
 * the uncommitted work is delivered to its destination before anything destructive happens. The
 * clone's switch to its base branch — the only step that removes files — comes last.
 *
 * The stash lives in the repo's common git dir, which is why a worktree that did not exist when
 * the stash was pushed can still pop it.
 */
export async function relocateToWorktree(path: string): Promise<RelocateResult> {
  const commands: string[] = []
  const computed = await computeRelocation(path)
  if ('error' in computed) return { error: computed.error, commands }

  const { repo, branch, worktreePath } = computed
  const root = repo.path
  const dirty = computed.dirtyCount > 0
  let detached = false
  let stashed = false
  let worktreeCreated = false

  try {
    commands.push('git checkout --detach')
    await git.detachHead(root)
    detached = true

    commands.push(`git worktree add ${worktreePath} ${branch}`)
    await git.addWorktreeForBranch(root, worktreePath, branch)
    worktreeCreated = true

    if (dirty) {
      commands.push('git stash push -u -m "maestro: moving to a worktree"')
      await git.stashPush(root, 'maestro: moving to a worktree')
      stashed = true

      commands.push(`git -C ${worktreePath} stash pop`)
      await git.stashPop(worktreePath)
      stashed = false
    }
  } catch (err) {
    const message = err instanceof git.GitError ? err.stderr.split('\n')[0] : String(err)
    // Unwind in reverse. The work is either still in the clone or already in the worktree; this
    // never leaves it in neither.
    if (stashed) await git.stashPop(root).catch(() => {})
    if (worktreeCreated) {
      await git.removeWorktree(root, worktreePath, branch, false, true).catch(() => {})
    }
    if (detached) await git.checkout(root, branch).catch(() => {})
    return { error: message || 'Could not move the work into a worktree.', commands }
  }

  // Only now does the clone lose the branch's files. Failing here is recoverable by hand and
  // leaves the moved work untouched, so it is not rolled back.
  try {
    commands.push(`git checkout ${repo.defaultBranch}`)
    await git.checkout(root, repo.defaultBranch)
  } catch (err) {
    const message = err instanceof git.GitError ? err.stderr.split('\n')[0] : String(err)
    console.error('[sessions] clone left detached:', message)
    commands.push(`# the clone is left on a detached HEAD; run: git -C ${root} checkout ${repo.defaultBranch}`)
  }

  const historyCopied = await copyClaudeHistory(root, worktreePath)
  if (historyCopied) commands.push('# copied Claude conversation history to the new path')

  await installHooks(worktreePath)

  const session: Session = {
    id: randomUUID(),
    repoId: repo.id,
    name: branch.replace(/^maestro\//, ''),
    branch,
    worktreePath,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    archived: false,
    setupState: 'ok',
    // Maestro created this worktree, so it may remove it — but the branch predates us.
    worktreeOwned: true,
    branchOwned: false,
    isPrimaryClone: false,
    // A conversation still running at the old path keeps being written there, so remember where
    // to sync it from.
    relocatedFrom: root
  }
  store.addSession(session)
  return { session, commands }
}

/**
 * Adopts an existing worktree — one created outside Maestro — without moving it or touching its
 * working tree, so uncommitted work is untouched and the Claude conversation stays resumable.
 * Registers the worktree's primary clone as a repo if it is not already known.
 */
export async function importWorktree(path: string): Promise<CreateResult> {
  const root = await git.repoRoot(path)
  if (!root) return { error: `${path} is not a git repository.` }

  if (store.sessions.some((s) => s.worktreePath === root && !s.archived)) {
    return { error: 'Maestro is already tracking that worktree.' }
  }

  // The primary clone is allowed. It is not a special case — it simply owns neither its worktree
  // nor its branch as far as Maestro is concerned, and git cannot remove a primary working tree
  // ("fatal: is a main working tree"), so the derived archive policy already refuses.
  const main = await git.mainRepoPath(root)
  const isPrimaryClone = main === root
  const repoPath = main ?? root
  let repo = store.repos.find((r) => r.path === repoPath)
  if (!repo) {
    const added = await addRepo(repoPath)
    if ('error' in added) return { error: added.error }
    repo = added
  }

  // Adding a removed repo back brings its sessions with it, and this may be one of them. Compared
  // resolved, because git reports real paths and a session's may run through a symlink.
  for (const candidate of store.sessions.filter((s) => s.repoId === repo.id && !s.archived)) {
    const real = await realpath(candidate.worktreePath).catch(() => candidate.worktreePath)
    if (candidate.worktreePath === root || real === root) return { session: candidate }
  }

  const branch = await git.currentBranch(root)
  await installHooks(root)

  const session: Session = {
    id: randomUUID(),
    repoId: repo.id,
    name: branch.replace(/^maestro\//, ''),
    branch,
    worktreePath: root,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    archived: false,
    // The tree already exists and its deps are already installed; never re-run setup over it.
    setupState: 'ok',
    // Maestro created neither, so it may remove neither.
    worktreeOwned: false,
    branchOwned: false,
    isPrimaryClone
  }
  store.addSession(session)
  return { session }
}

export async function addRepo(path: string): Promise<Repo | { error: string }> {
  const root = await git.repoRoot(path)
  if (!root) return { error: `${path} is not a git repository.` }
  const defaultBranch = await git.detectDefaultBranch(root)
  return store.addRepo({ name: basename(root), path: root, defaultBranch })
}

export interface CreateResult {
  session?: Session
  error?: string
}

/**
 * Branches from `base` — the repo's default branch unless the caller picked another branch or
 * an in-flight session's branch. Note that only *committed* work carries over: a worktree is cut
 * from a ref, so uncommitted changes in the source session stay where they are.
 *
 * With `mode: 'continue'` the branch is checked out as it is instead — see
 * {@link continueOnBranch}.
 */
export async function createSession(
  repoId: string,
  name: string,
  base?: string,
  mode: StartMode = 'branch',
  launch: LaunchSettings = {}
): Promise<CreateResult> {
  const repo = store.repo(repoId)
  if (!repo) return { error: 'Repo not found.' }

  const trimmed = name.trim()
  const baseRef = base?.trim() || repo.defaultBranch
  if (!(await git.branchExists(repo.path, baseRef))) {
    return { error: `${baseRef} is not a branch in this repo.` }
  }

  if (mode === 'continue') return continueOnBranch(repo, trimmed, baseRef, launch)

  /*
   * The directory and the branch share one random handle rather than a slug of what the user typed.
   * That text is now Claude's opening message, so it is a sentence, not a label — and the directory
   * is the one name that can never be corrected later, since Claude Code keys its history by the
   * absolute path. The readable name arrives afterwards from Claude's own title.
   *
   * Which is also why saying anything here is optional: neither name depends on it, so there is
   * nothing to know before the worktree can be cut. Say nothing and the session opens on Claude's
   * own prompt instead — the real one, with every skill, file completion and shorthand it has.
   *
   * Both names are still checked, and re-rolled rather than suffixed: a collision means the handle
   * was already taken, and the next one almost certainly is not.
   */
  let handle = randomHandle()
  let worktreePath = join(worktreeRoot(), repo.name, handle)
  for (let attempt = 0; attempt < 20; attempt++) {
    const taken =
      (await pathExists(worktreePath)) ||
      (await git.branchExists(repo.path, `feature/${handle}`))
    if (!taken) break
    handle = randomHandle()
    worktreePath = join(worktreeRoot(), repo.name, handle)
  }
  // createWorktree suffixes the branch if it is somehow still taken, and returns what it used.
  const candidateBranch = `feature/${handle}`

  let branch: string
  try {
    branch = await git.createWorktree(repo.path, candidateBranch, worktreePath, baseRef)
  } catch (err) {
    const message = err instanceof git.GitError ? err.stderr.split('\n')[0] || err.message : String(err)
    return { error: message }
  }

  await installHooks(worktreePath)

  const session: Session = {
    id: randomUUID(),
    repoId: repo.id,
    // The handle until Claude titles the conversation — which it does whether the opening message
    // came from here or was typed into Claude itself.
    name: trimmed || handle,
    branch,
    worktreePath,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    archived: false,
    ...(await setupFields(worktreePath)),
    worktreeOwned: true,
    branchOwned: true,
    isPrimaryClone: false,
    // What the user said they were building is the work itself, not just a label — hand it to
    // Claude as the opening message so the session starts on the task instead of an empty prompt.
    initialPrompt: trimmed || undefined,
    // …and the same text, summarised by Claude, is what this session ends up called.
    awaitingTitle: true,
    model: launch.model,
    effort: launch.effort
  }
  store.addSession(session)
  return { session }
}

/**
 * What a freshly cut worktree still has to build before it is workable — read from the tree it just
 * checked out, which is the only place a setup script is looked for.
 *
 * `pending` only where the branch actually carries one, so a repo without a script never leaves a
 * session waiting on nothing. Only the paths that cut a worktree ask: an imported one was built by
 * whoever made it, and a local session has no repo to carry a script.
 */
async function setupFields(
  worktreePath: string
): Promise<Pick<Session, 'setupState' | 'setupBackground'>> {
  const script = await setupScriptIn(worktreePath)
  if (!script) return { setupState: 'ok' }
  return { setupState: 'pending', setupBackground: (await isBackground(script)) || undefined }
}

/** A branch name as it reads to a person, without the prefix Maestro puts on the ones it creates. */
function bareBranch(branch: string): string {
  return branch.replace(/^(feature|maestro)\//, '')
}

/**
 * Picks up an existing branch rather than starting one on top of it: the worktree checks the branch
 * out as it is, so commits land on that branch and nothing new is created to merge back later. For
 * the work that already has a branch — a colleague's, one left over from a previous session, one
 * made by hand outside Maestro.
 *
 * A remote branch is picked up by giving it a local half that tracks it: `origin/fix-login` becomes
 * a local `fix-login` with its upstream set, so pushing updates that same remote branch. Branching
 * from it would instead leave the remote branch with nobody working on it, which is the opposite of
 * what picking it up means. A local branch of that name already existing is not a collision to work
 * around — it *is* the local half, so the worktree simply checks it out.
 *
 * Git allows a ref to be checked out in one worktree at a time, so a branch another worktree holds
 * is refused here rather than at `git worktree add`, where the error names paths instead of saying
 * what to do about it.
 *
 * The directory takes the branch's name, not a random handle: unlike a new session, this one has a
 * real name from the start, and the handle exists precisely because a new session does not.
 *
 * Maestro owns the worktree it made but not the branch it found — so archiving removes the
 * directory and leaves the branch, and the session never renames it out from under whoever else
 * refers to it.
 */
async function continueOnBranch(
  repo: Repo,
  name: string,
  ref: string,
  launch: LaunchSettings = {}
): Promise<CreateResult> {
  const remote = await git.isRemoteRef(repo.path, ref)
  const branch = remote ? git.localNameOf(ref) : ref
  if (!branch) return { error: `${ref} does not name a branch to continue on.` }

  // The local half may already exist — cloned earlier, or left behind by a session that has gone.
  // Then this is the plain local case, upstream and all, and nothing needs creating.
  const needsLocalBranch = remote && !(await git.branchExists(repo.path, branch))

  const holders = await git.checkedOutAt(repo.path, branch)
  if (holders.length > 0) {
    return {
      error: `${branch} is already checked out at ${holders[0]} — branch from it instead.`
    }
  }

  const slug = slugify(bareBranch(branch))
  let worktreePath = join(worktreeRoot(), repo.name, slug)
  let suffix = 1
  while (await pathExists(worktreePath)) {
    suffix += 1
    worktreePath = join(worktreeRoot(), repo.name, `${slug}-${suffix}`)
  }

  try {
    if (needsLocalBranch) {
      await git.addWorktreeTracking(repo.path, worktreePath, branch, ref)
    } else {
      await git.addWorktreeForBranch(repo.path, worktreePath, branch)
    }
  } catch (err) {
    const message = err instanceof git.GitError ? err.stderr.split('\n')[0] || err.message : String(err)
    return { error: message }
  }

  await installHooks(worktreePath)

  const session: Session = {
    id: randomUUID(),
    repoId: repo.id,
    name: name || bareBranch(branch),
    branch,
    worktreePath,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    archived: false,
    ...(await setupFields(worktreePath)),
    worktreeOwned: true,
    // The branch predates this session and outlives it.
    branchOwned: false,
    isPrimaryClone: false,
    /*
     * Saying what you are about to do stays optional here, because the branch already says what the
     * work is. Say it and it is Claude's opening message and the session's name, as everywhere else;
     * leave it and the session is simply the branch, opened.
     */
    initialPrompt: name || undefined,
    awaitingTitle: name ? true : undefined,
    model: launch.model,
    effort: launch.effort
  }
  store.addSession(session)
  return { session }
}

/** Accepts what a person would type: `~/notes` is a real path to them, not to the filesystem. */
export function expandHome(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * Opens a plain folder as a session: a real Claude terminal and the editor, with none of the git
 * machinery. For the work that is not a feature branch — notes, a scratch directory, a config file
 * somewhere in ~ — where the alternative was leaving Maestro for a separate terminal.
 *
 * The two ways in mirror sessions proper. By default Maestro makes the directory, under the same
 * root as the worktrees it makes, so a place to work costs one name and nothing else. Give it a
 * path instead and it works there in place, exactly as importing a worktree does.
 */
export async function createLocalSession(
  text: string,
  path?: string,
  launch: LaunchSettings = {}
): Promise<CreateResult> {
  const trimmed = text.trim()
  const typed = expandHome(path ?? '')

  let dir: string
  if (typed) {
    dir = resolvePath(typed)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(dir)
    } catch {
      return { error: `${dir} does not exist.` }
    }
    if (!info.isDirectory()) return { error: `${dir} is not a folder.` }
  } else {
    /*
     * A random handle, for the same reason a worktree gets one: the text is Claude's opening
     * message now, so it is a sentence rather than a label, and the directory is the one name that
     * can never be corrected afterwards — Claude Code keys its history by the absolute path.
     * Re-rolled rather than suffixed on a collision; the next handle almost certainly is free.
     */
    let handle = randomHandle()
    dir = join(localRoot(), handle)
    for (let attempt = 0; attempt < 20 && (await pathExists(dir)); attempt++) {
      handle = randomHandle()
      dir = join(localRoot(), handle)
    }
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      return { error: `Could not create ${dir}: ${String(err)}` }
    }
  }

  /*
   * A folder already open in another session is opened again, not refused: several agents working
   * one folder is a way of working, and the note below is what keeps them from trampling each
   * other. Only the name is made distinct, so the sidebar can tell the sessions apart.
   */
  const taken = new Set(
    store.sessions.filter((s) => isLocal(s) && !s.archived && s.worktreePath === dir).map((s) => s.name)
  )
  const base = trimmed || basename(dir) || dir
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`

  // The same hooks every other session gets — without them the sidebar dot for this session would
  // never move off idle.
  await installHooks(dir)

  const session: Session = {
    id: randomUUID(),
    repoId: LOCAL_REPO_ID,
    name,
    branch: '',
    worktreePath: dir,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    archived: false,
    // There is no setup script without a repo, so there is nothing to wait for.
    setupState: 'ok',
    /*
     * True only when Maestro made the directory — which is what tells the view it is brand new and
     * has no conversation to offer picking up. Deleting the folder is a separate opt-in either
     * way, because a folder has no branch holding its contents (see localFolderRefusal).
     */
    worktreeOwned: !typed,
    branchOwned: false,
    isPrimaryClone: false,
    /*
     * A folder Maestro just made is empty, so what the user typed is the work — hand it to Claude
     * as the opening message and take the session's name from Claude's summary of it, exactly as a
     * repo session does.
     *
     * A folder that already existed gets neither. The title is read from the newest conversation in
     * the directory, and a directory with history has conversations that are not this one — so the
     * session would be liable to name itself after work from last week. There it keeps the name
     * given here.
     */
    initialPrompt: typed ? undefined : trimmed || undefined,
    awaitingTitle: typed ? undefined : true,
    model: launch.model,
    effort: launch.effort
  }
  store.addSession(session)
  await syncSharedFolderNote(dir)
  return { session }
}

/** What one attempt at naming a session found. */
export type TitleAttempt =
  /** The session took Claude's title for its own. */
  | 'named'
  /** Nothing has been said in this worktree yet, so no title is late. */
  | 'idle'
  /** A conversation is under way and Claude has not titled it yet. */
  | 'waiting'
  /** Nothing left to name — the session is gone, or already has its name. */
  | 'done'

/**
 * Names a session from the title Claude gave its first conversation, replacing the random handle it
 * was created with. What it returns tells the caller whether to keep waiting, and — through `idle` —
 * whether waiting has even begun.
 *
 * The worktree directory keeps its handle for good: Claude Code's history key is the absolute path,
 * so moving it would orphan the very transcript this title came from. The branch is renamed too,
 * but only when it is Maestro's own and still local — a branch the session merely picked up belongs
 * to whoever made it, and a pushed one has a remote copy and possibly a PR pointing at it.
 */
export async function applyGeneratedTitle(sessionId: string): Promise<TitleAttempt> {
  const session = store.session(sessionId)
  if (!session?.awaitingTitle) return 'done'

  const conversation = await newestConversation(session.worktreePath)
  if (!conversation) return 'idle'
  const title = conversation.title
  if (!title) return 'waiting'

  const patch: Partial<Session> = { name: title, awaitingTitle: undefined }
  const repo = store.repo(session.repoId)

  if (repo && session.branchOwned && !(await git.isPublished(repo.path, session.branch))) {
    let target = `feature/${slugify(title)}`
    let suffix = 1
    while (target !== session.branch && (await git.branchExists(repo.path, target))) {
      suffix += 1
      target = `feature/${slugify(title)}-${suffix}`
      // Keep the handle rather than climbing forever through taken names.
      if (suffix > 5) {
        target = session.branch
        break
      }
    }
    if (target !== session.branch) {
      try {
        await git.renameBranch(repo.path, session.branch, target)
        patch.branch = target
      } catch (err) {
        // A readable branch name is a nicety; failing to get one must not cost the session its name.
        console.error('[sessions] branch rename failed', err)
      }
    }
  }

  store.updateSession(sessionId, patch)
  return 'named'
}

/**
 * Launches the agent. This is a real `claude` PTY, not a wrapper — every Claude Code feature
 * renders natively (PLAN.md §1, §4). The state-file env var is what the installed hooks write to.
 */
export function launchClaude(
  session: Session,
  cols: number,
  rows: number,
  launch: ClaudeLaunch
): { id: string } {
  const args: string[] = []
  if (launch.mode === 'continue') {
    args.push('--continue')
  } else if (launch.mode === 'resume') {
    // Explicit id, so the caller decides which conversation rather than getting "most recent".
    args.push('--resume', launch.conversationId)
    // Forking leaves the original transcript alone, which is what makes it safe to reopen a
    // conversation another Claude still has running.
    if (launch.fork) args.push('--fork-session')
  }

  /*
   * Permission mode is settable only at launch — there is no way in from outside a running REPL —
   * so the stored preference has to be applied here or not at all. Absent, no flag is passed, which
   * is not the same as passing the default: it leaves Claude's own configuration in charge.
   *
   * Ahead of the prompt, because the prompt is positional and everything after it would be read as
   * part of it.
   */
  const { permissionMode } = store.preferences
  if (permissionMode) args.push('--permission-mode', permissionMode)

  /*
   * Model and effort were chosen for this session when it was created, and are re-applied on every
   * launch rather than consumed once. Absent means no flag, on the same terms as the mode above —
   * `/model` and `/effort` inside the running session still override either of them.
   */
  if (session.model) args.push('--model', session.model)
  if (session.effort) args.push('--effort', session.effort)

  /*
   * `claude [options] [prompt]` opens the interactive session and submits that prompt as the first
   * turn — the same REPL, already working. It is passed as an argv entry rather than typed into the
   * PTY, so nothing depends on Claude's startup timing and no quoting can mangle it.
   */
  const prompt = launch.mode === 'new' ? launch.prompt?.trim() : undefined
  if (prompt) args.push(prompt)

  /*
   * Resolved explicitly so a missing binary explains itself. Spawning a name that is not on PATH
   * exits 1 with nothing on stdout, which is what made this look like Claude had crashed rather
   * than never having started.
   */
  const binary = resolveBinary('claude')
  if (!binary) {
    const message =
      'claude was not found on PATH.\\n\\n' +
      'Maestro launched without your shell environment, so it cannot see ~/.local/bin. ' +
      'Reinstall the app after updating, or start it from a terminal with: npm run dev'
    return ptys.spawnScript(
      session.id,
      session.worktreePath,
      'Claude',
      `printf '%b\\n' "${message}"; exit 127`,
      cols,
      rows
    )
  }

  return ptys.spawn({
    sessionId: session.id,
    kind: 'claude',
    label: 'Claude',
    cwd: session.worktreePath,
    command: binary,
    args,
    cols,
    rows,
    env: { [STATE_FILE_ENV]: stateFileFor(session.id) },
    // Only a clean exit sends SessionEnd, so the dot needs the process itself to say it has gone.
    onExit: () => agentStates.settle(session.id)
  })
}

/**
 * Runs the worktree's own `.maestro/setup.sh`, in a terminal tab of its own. Also what "run setup"
 * calls when asked for again by hand — worth having, because the script is written in a worktree and
 * trying it where you wrote it beats cutting a session to find out whether it works.
 *
 * A session can be `pending` and find no script — the file was deleted, or the session was restored
 * from before it existed. That is not a failure: there is nothing to build, so the worktree is as
 * built as it is going to get, and anything holding out for setup is released rather than left
 * waiting on a script that is never coming.
 *
 * `onSettled` is how the finish gets out of this process. The store has no change notification, so
 * writing `ok` here reaches nobody: the footer went on saying "setup running" for a script that had
 * long since exited, and a session holding its first turn for setup held it for the rest of the run.
 */
export async function runSetupScript(
  session: Session,
  cols: number,
  rows: number,
  onSettled?: () => void
): Promise<{ id: string } | null> {
  const script = await setupScriptIn(session.worktreePath)
  if (!script) {
    store.updateSession(session.id, { setupState: 'ok' })
    return null
  }
  store.updateSession(session.id, { setupState: 'running' })
  return ptys.spawnScript(
    session.id,
    session.worktreePath,
    'setup',
    await setupCommand(script),
    cols,
    rows,
    {
      keepOpen: false,
      onExit: (code) => {
        store.updateSession(session.id, { setupState: code === 0 ? 'ok' : 'failed' })
        onSettled?.()
      }
    }
  )
}

/**
 * What archiving would do. Every permission is derived from the ownership facts rather than from
 * a flag meaning "imported", so the primary clone and a hand-made worktree fall out of the same
 * rules instead of needing their own branches.
 */
/**
 * Why a folder may not be deleted, or undefined when it may. Deleting a folder is final, so these
 * refuse every case where it would take more than intended — a home directory, a folder holding
 * Maestro's own roots or the directory of a session not going with it, or the checkout Maestro is
 * running from.
 */
async function folderRefusal(
  path: string,
  goingWith: (session: Session) => boolean
): Promise<string | undefined> {
  const dir = resolvePath(path)
  if (!(await pathExists(dir))) return 'it is already gone'
  const guarded = [homedir(), resolvePath(worktreeRoot()), resolvePath(localRoot())]
  if (dir === '/' || guarded.some((root) => isInside(root, dir))) {
    return 'it holds your home folder or Maestro’s own folders'
  }
  if (isSelfHosted(dir)) return 'Maestro is running from it'
  const other = store.allSessions.find(
    (s) => !goingWith(s) && isInside(resolvePath(s.worktreePath), dir)
  )
  if (other) return `“${other.name}” also works in it`
  return undefined
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

function localFolderRefusal(session: Session): Promise<string | undefined> {
  return folderRefusal(session.worktreePath, (s) => s.id === session.id)
}

export async function archivePlan(sessionId: string): Promise<ArchivePlan | null> {
  const session = store.session(sessionId)
  if (!session) return null

  /*
   * A local session has no worktree to remove and no branch to delete. Its folder stays unless
   * deleting it is asked for explicitly: a worktree can be deleted because its branch still holds
   * the commits, and a folder has no such backstop.
   */
  if (isLocal(session)) {
    const folderRefusal = await localFolderRefusal(session)
    return {
      sessionId,
      worktreePath: session.worktreePath,
      branch: '',
      canRemoveWorktree: false,
      canDeleteBranch: false,
      worktreeIsForeign: false,
      branchIsForeign: false,
      isPrimaryClone: false,
      worktreeOwned: false,
      branchOwned: false,
      isLocal: true,
      canDeleteFolder: folderRefusal === undefined,
      folderRefusal,
      archived: session.archived,
      worktreeGone: false,
      dirtyCount: 0,
      notes: [],
      // Nothing was removed, so reopening it is only a matter of unhiding the session.
      restorable: true
    }
  }

  const notes: string[] = []
  /*
   * An archived session's worktree is usually already gone, and every permission below turns on
   * that: there is nothing left to remove, no uncommitted work left to destroy, and nothing holding
   * the branch. Read from disk rather than from `archived`, because a worktree removed by hand puts
   * a live session in exactly the same position.
   */
  const worktreeGone = !(await pathExists(session.worktreePath))
  /*
   * The primary clone stays a hard no: git refuses to remove a primary working tree, so permitting
   * it would only produce a failure. Anything else is allowed with an explicit opt-in — a worktree
   * or branch the user made by hand is theirs to remove, it just cannot be rebuilt by Maestro, so
   * it is warned about rather than blocked.
   */
  const worktreeIsForeign = !session.worktreeOwned
  const branchIsForeign = !session.branchOwned
  const canRemoveWorktree = !session.isPrimaryClone && !worktreeGone
  if (session.isPrimaryClone) {
    notes.push('This is the repo’s primary clone — git cannot remove it, so the directory stays.')
  } else if (worktreeGone) {
    // The path is already in the dialog's subtitle, so the note says what is left rather than
    // repeating it.
    notes.push('The worktree is already gone — only the branch and the session record are left.')
  }

  // A branch still checked out somewhere cannot be deleted, so nothing may hold it afterwards:
  // either this removes the worktree that did, or the worktree is already gone.
  const holders = await git.checkedOutAt(
    store.repo(session.repoId)?.path ?? session.worktreePath,
    session.branch
  )
  // Compared resolved: git lists real paths, and the session's may run through a symlink.
  const own = await realpath(session.worktreePath).catch(() => session.worktreePath)
  const stillCheckedOut = holders.filter((p) => p !== session.worktreePath && p !== own)
  const canDeleteBranch = (canRemoveWorktree || worktreeGone) && stillCheckedOut.length === 0
  if (stillCheckedOut.length > 0) {
    notes.push(`${session.branch} is also checked out at ${stillCheckedOut[0]}, so it cannot be deleted.`)
  }

  return {
    sessionId,
    worktreePath: session.worktreePath,
    branch: session.branch,
    canRemoveWorktree,
    canDeleteBranch,
    worktreeIsForeign,
    branchIsForeign,
    isPrimaryClone: session.isPrimaryClone,
    worktreeOwned: session.worktreeOwned,
    branchOwned: session.branchOwned,
    isLocal: false,
    canDeleteFolder: false,
    archived: session.archived,
    worktreeGone,
    dirtyCount: worktreeGone ? 0 : await git.dirtyCount(session.worktreePath),
    notes,
    // Restoring recreates the worktree from the branch, so it needs the branch to survive — which
    // archive always guarantees — and a directory that is not in the way.
    restorable: canRemoveWorktree || worktreeGone,
    archivedStash: session.archivedStash
  }
}

/**
 * Deals with uncommitted work before the worktree goes. Every outcome is explicit: nothing is
 * discarded unless discarding was chosen.
 */
async function settleWip(
  session: Session,
  wip: WipPlan,
  commands: string[]
): Promise<{ ok: boolean; error?: string; stash?: string }> {
  if (wip === 'commit') {
    const result = await git.commitAll(session.worktreePath, 'WIP before archiving')
    commands.push(...result.commands)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }

  if (wip === 'stash') {
    commands.push('git stash push -u -m "maestro: archived <session>"')
    try {
      const ref = await git.stashPushRef(session.worktreePath, `maestro: archived ${session.name}`)
      return { ok: true, stash: ref ?? undefined }
    } catch (err) {
      const message = err instanceof git.GitError ? err.stderr.split('\n')[0] : String(err)
      return { ok: false, error: message || 'Could not stash the changes.' }
    }
  }

  return { ok: true }
}

/**
 * Archives or deletes a session.
 *
 * Archive keeps the branch and the record, so it can be undone; delete keeps nothing. Both remove
 * the worktree directory when Maestro owns it — that is the disk-space part, and it is the same
 * operation either way.
 *
 * Deleting a session that is already archived is the same call: archiving left a branch and a
 * record, and this is what removes them.
 */
export async function disposeSession(
  sessionId: string,
  options: DisposeOptions
): Promise<ArchiveResult> {
  const session = store.session(sessionId)
  if (!session) return { ok: false, error: 'Session not found.', commands: [] }
  const repo = store.repo(session.repoId)
  const commands: string[] = []

  const plan = await archivePlan(sessionId)
  if (!plan) return { ok: false, error: 'Session not found.', commands }

  if (plan.dirtyCount > 0 && options.wip === 'leave' && plan.canRemoveWorktree) {
    return {
      ok: false,
      error: `${plan.dirtyCount} uncommitted file(s) would be lost. Commit, stash or discard them first.`,
      commands
    }
  }

  if (options.deleteFolder && plan.isLocal && !plan.canDeleteFolder) {
    return { ok: false, error: `Can’t delete the folder: ${plan.folderRefusal ?? 'not allowed'}.`, commands }
  }

  const settled = await settleWip(session, options.wip, commands)
  if (!settled.ok) return { ok: false, error: settled.error, commands }

  // Permissions are the plan's, not the caller's: the renderer can only narrow them. Removing
  // something Maestro did not create additionally requires the explicit opt-in.
  const removeWorktree = plan.canRemoveWorktree && (!plan.worktreeIsForeign || options.allowForeign)
  const deleteBranch =
    options.action === 'delete' &&
    options.deleteBranch &&
    plan.canDeleteBranch &&
    (!plan.branchIsForeign || options.allowForeign)

  ptys.killSession(sessionId)
  agentStates.forget(sessionId)
  titleWatcher.cancel(sessionId)

  const deleteFolder = options.action === 'delete' && options.deleteFolder === true && plan.isLocal
  if (deleteFolder) {
    try {
      commands.push(`rm -rf ${session.worktreePath}`)
      await rm(session.worktreePath, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: `Could not delete ${session.worktreePath}: ${String(err)}`, commands }
    }
  }

  if (removeWorktree && repo) {
    try {
      const result = await git.removeWorktree(
        repo.path,
        session.worktreePath,
        session.branch,
        deleteBranch,
        // Discarding is the only path that forces past git's refusal.
        options.wip === 'discard'
      )
      commands.push(...result.commands)
    } catch (err) {
      const message = err instanceof git.GitError ? err.stderr.split('\n')[0] : String(err)

      // The fallback is gated. It used to fire on any failure, which turned "git refused because
      // the tree is dirty" into silent destruction.
      if (!options.hardDelete) {
        return { ok: false, error: message || 'Could not remove the worktree.', commands }
      }
      commands.push(`rm -rf ${session.worktreePath}`)
      await rm(session.worktreePath, { recursive: true, force: true })
      commands.push('git worktree prune')
      await git.pruneWorktrees(repo.path)
      if (deleteBranch) {
        commands.push(`git branch -D ${session.branch}`)
        await git.deleteBranch(repo.path, session.branch)
      }
    }
  } else if (deleteBranch && repo) {
    /*
     * Nothing to remove on disk — this is the archived case, where the branch is the only thing
     * archiving left behind. A branch already deleted by hand is not an error: the requested end
     * state is what matters, and it is already true.
     */
    commands.push('git worktree prune')
    await git.pruneWorktrees(repo.path)
    if (await git.branchExists(repo.path, session.branch)) {
      try {
        commands.push(`git branch -D ${session.branch}`)
        await git.deleteBranch(repo.path, session.branch)
      } catch (err) {
        const message = err instanceof git.GitError ? err.stderr.split('\n')[0] : String(err)
        return { ok: false, error: message || `Could not delete ${session.branch}.`, commands }
      }
    }
  }

  if (options.action === 'archive') {
    store.updateSession(sessionId, {
      archived: true,
      archivedAt: Date.now(),
      archivedStash: settled.stash
    })
  } else {
    store.removeSession(sessionId)
  }
  if (isLocal(session)) await syncSharedFolderNote(session.worktreePath)
  return { ok: true, commands }
}

/** Local sessions working in `dir`, open and archived. */
function localSessionsIn(dir: string): Session[] {
  return store.sessions.filter((s) => isLocal(s) && s.worktreePath === dir)
}

export async function localFolderPlan(dir: string): Promise<LocalFolderPlan> {
  const sessions = localSessionsIn(dir)
  const refusal = await folderRefusal(dir, (s) => isLocal(s) && s.worktreePath === dir)
  return {
    path: dir,
    sessionIds: sessions.filter((s) => !s.archived).map((s) => s.id),
    archivedIds: sessions.filter((s) => s.archived).map((s) => s.id),
    canDeleteFolder: refusal === undefined,
    folderRefusal: refusal,
    madeByMaestro: sessions.length > 0 && sessions.every((s) => s.worktreeOwned)
  }
}

/**
 * Deletes every open session in a local folder, and with `deleteFolder` the folder and the archived
 * sessions that pointed at it. Each session goes through {@link disposeSession}, so its Claude stops
 * and the shared-folder note is kept in step exactly as for a single delete.
 */
export async function deleteLocalFolder(dir: string, deleteFolder: boolean): Promise<ArchiveResult> {
  const commands: string[] = []
  const plan = await localFolderPlan(dir)
  if (deleteFolder && !plan.canDeleteFolder) {
    return {
      ok: false,
      error: `Can’t delete the folder: ${plan.folderRefusal ?? 'not allowed'}.`,
      commands
    }
  }

  for (const id of plan.sessionIds) {
    const result = await disposeSession(id, {
      action: 'delete',
      wip: 'leave',
      deleteBranch: false,
      allowForeign: false,
      hardDelete: false
    })
    commands.push(...result.commands)
    if (!result.ok) return { ok: false, error: result.error, commands }
  }

  if (deleteFolder) {
    try {
      commands.push(`rm -rf ${dir}`)
      await rm(dir, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: `Could not delete ${dir}: ${String(err)}`, commands }
    }
    for (const id of plan.archivedIds) store.removeSession(id)
  }
  return { ok: true, commands }
}

/** What removing a repo could do to each of its sessions and to its folder, for the dialog. */
export async function removeRepoPlan(repoId: string): Promise<RemoveRepoPlan | null> {
  const repo = store.repo(repoId)
  if (!repo) return null
  const sessions: ArchivePlan[] = []
  for (const session of store.sessions.filter((s) => s.repoId === repoId)) {
    const plan = await archivePlan(session.id)
    if (plan) sessions.push(plan)
  }
  return { sessions, folder: await repoFolderPlan(repo) }
}

async function repoFolderPlan(repo: Repo): Promise<RepoFolderPlan> {
  let refusal = await folderRefusal(repo.path, (s) => s.repoId === repo.id)

  /*
   * A worktree no session tracks would be left pointing at a repo that no longer exists, and it is
   * work Maestro has never shown. It is named rather than swept up.
   */
  if (!refusal) {
    const running = store.allSessions.find(
      (s) => s.repoId === repo.id && isSelfHosted(resolvePath(s.worktreePath))
    )
    if (running) refusal = `Maestro is running from “${running.name}”`
  }

  if (!refusal) {
    const tracked = new Set<string>()
    for (const s of store.allSessions.filter((x) => x.repoId === repo.id)) {
      tracked.add(s.worktreePath)
      tracked.add(await realpath(s.worktreePath).catch(() => s.worktreePath))
    }
    let stray: { path: string } | undefined
    for (const w of await git.listWorktrees(repo.path)) {
      // A directory already gone is only stale metadata, and goes with the clone.
      if (!w.isMain && !tracked.has(w.path) && (await pathExists(w.path))) {
        stray = w
        break
      }
    }
    if (stray) refusal = `${stray.path} is a worktree Maestro doesn’t track`
  }

  const primaryTracked = store.sessions.some((s) => s.repoId === repo.id && s.isPrimaryClone)
  return {
    path: repo.path,
    canDelete: refusal === undefined,
    refusal,
    unpushedCommits: await git.unpushedCommitCount(repo.path),
    stashes: await git.stashCount(repo.path),
    dirtyFiles: primaryTracked ? 0 : await git.dirtyCount(repo.path)
  }
}

/**
 * Takes a repo out of Maestro. The repo is hidden, never dropped: its sessions stop and go with it,
 * and adding the same path again brings them back.
 *
 * Deleting worktrees and branches is opt-in, and runs through {@link disposeSession} one session
 * at a time, so every guard a single delete has — uncommitted work, foreign worktrees, branches
 * still checked out — holds here too. A session that loses only its worktree is archived and stays
 * restorable; one that loses its branch as well has nothing left to restore, so it is deleted.
 * The repo stays visible if any of it fails, so what is left can be retried.
 */
export async function removeRepo(repoId: string, options: RemoveRepoOptions): Promise<ArchiveResult> {
  const commands: string[] = []
  const plan = await removeRepoPlan(repoId)
  const repo = store.repo(repoId)
  if (!plan || !repo) return { ok: false, error: 'Repo not found.', commands }

  const deleteFolder = options.deleteFolder
  if (deleteFolder && !plan.folder.canDelete) {
    return {
      ok: false,
      error: `Can’t delete the repo folder: ${plan.folder.refusal ?? 'not allowed'}.`,
      commands
    }
  }

  if (options.removeWorktrees || options.deleteBranches || deleteFolder) {
    for (const sessionPlan of plan.sessions) {
      const { deletesBranch, untouched } = removalStep(sessionPlan, options)
      if (untouched) continue

      const result = await disposeSession(sessionPlan.sessionId, {
        // With the clone going there is nothing to archive back to.
        action: deletesBranch || deleteFolder ? 'delete' : 'archive',
        // A commit or stash would live in the clone about to be deleted.
        wip: sessionPlan.dirtyCount === 0 ? 'leave' : deleteFolder ? 'discard' : options.wip,
        deleteBranch: deletesBranch,
        // Only for the worktree: deletesBranch already excludes every branch Maestro did not create.
        allowForeign: options.allowForeign || deleteFolder,
        hardDelete: deleteFolder
      })
      commands.push(...result.commands)
      if (!result.ok) {
        const name = store.session(sessionPlan.sessionId)?.name ?? sessionPlan.branch
        return { ok: false, error: `${name}: ${result.error ?? 'failed.'}`, commands }
      }
    }
  }

  for (const session of store.sessions.filter((s) => s.repoId === repoId)) {
    ptys.killSession(session.id)
    agentStates.forget(session.id)
    titleWatcher.cancel(session.id)
  }

  if (deleteFolder) {
    try {
      commands.push(`rm -rf ${repo.path}`)
      await rm(repo.path, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: `Could not delete ${repo.path}: ${String(err)}`, commands }
    }
    // Nothing is left to come back, so the record goes rather than hiding.
    store.dropRepo(repoId)
  } else {
    store.hideRepo(repoId)
  }
  return { ok: true, commands }
}

/**
 * Rebuilds an archived session's worktree from its branch and puts back the stash archiving took,
 * if there was one. The branch was never touched, so the committed work is exactly as it was.
 *
 * The conversation comes back with it. Archiving removes the directory but never Claude's history
 * for it, which is keyed by path and lives under ~/.claude — so a worktree rebuilt at the same
 * path finds its transcripts waiting, and one rebuilt elsewhere has them copied across.
 * `restoredAt` is what tells the renderer to continue that conversation rather than open a new one.
 */
export async function restoreSession(sessionId: string): Promise<ArchiveResult> {
  const session = store.session(sessionId)
  if (!session) return { ok: false, error: 'Session not found.', commands: [] }

  // Nothing was removed when a local session was archived, so restoring is just unhiding it —
  // provided the folder is still there.
  if (isLocal(session)) {
    if (!(await pathExists(session.worktreePath))) {
      return { ok: false, error: `${session.worktreePath} no longer exists.`, commands: [] }
    }
    store.updateSession(sessionId, {
      archived: false,
      archivedAt: undefined,
      restoredAt: Date.now(),
      lastActivity: Date.now()
    })
    await syncSharedFolderNote(session.worktreePath)
    return { ok: true, commands: [] }
  }

  const repo = store.repo(session.repoId)
  if (!repo) return { ok: false, error: 'Repo not found.', commands: [] }
  const commands: string[] = []

  if (!(await git.branchExists(repo.path, session.branch))) {
    return {
      ok: false,
      error: `${session.branch} no longer exists, so there is nothing to restore.`,
      commands
    }
  }

  // The old path may have been taken since; find a free one rather than failing.
  let worktreePath = session.worktreePath
  let suffix = 1
  while (await pathExists(worktreePath)) {
    suffix += 1
    worktreePath = `${session.worktreePath}-${suffix}`
  }

  try {
    commands.push(`git worktree add ${worktreePath} ${session.branch}`)
    await git.addWorktreeForBranch(repo.path, worktreePath, session.branch)
  } catch (err) {
    const message = err instanceof git.GitError ? err.stderr.split('\n')[0] : String(err)
    return { ok: false, error: message || 'Could not recreate the worktree.', commands }
  }

  if (session.archivedStash) {
    try {
      commands.push(`git stash apply ${session.archivedStash.slice(0, 8)}`)
      await git.stashApplyRef(worktreePath, session.archivedStash)
    } catch {
      // The stash may have been dropped by hand; the committed work is still restored.
      commands.push('# the archived stash could not be applied — it may have been dropped')
    }
  }

  /*
   * A worktree that could not go back to its old path is a relocation as far as Claude is
   * concerned — the history key is the directory — so the conversations move with it. Without
   * this, restoring into a taken path silently opened a session with no past.
   */
  if (worktreePath !== session.worktreePath) {
    const carried = await copyClaudeHistory(session.worktreePath, worktreePath)
    if (carried) commands.push('# conversation history copied to the new path')
  }

  await installHooks(worktreePath)
  store.updateSession(sessionId, {
    archived: false,
    archivedAt: undefined,
    archivedStash: undefined,
    restoredAt: Date.now(),
    worktreePath,
    lastActivity: Date.now()
  })
  return { ok: true, commands }
}
