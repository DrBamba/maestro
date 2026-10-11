import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import type {
  BranchSync,
  ChangeKind,
  ChangedFile,
  Commit,
  GitStatus,
  Landing,
  MergeMode,
  PrStatus,
  CheckState
} from '@shared/types'

const exec = promisify(execFile)

const MAX_BUFFER = 32 * 1024 * 1024
/** Untracked files larger than this are reported without a line count. */
const UNTRACKED_COUNT_LIMIT = 2 * 1024 * 1024

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: MAX_BUFFER })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    throw new GitError(`git ${args[0]} failed: ${e.message}`, e.stderr ?? '')
  }
}

/** Runs git but returns null instead of throwing — for probes where failure is a valid answer. */
async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

export async function isRepo(path: string): Promise<boolean> {
  const out = await gitOrNull(path, ['rev-parse', '--is-inside-work-tree'])
  return out?.trim() === 'true'
}

export async function repoRoot(path: string): Promise<string | null> {
  const out = await gitOrNull(path, ['rev-parse', '--show-toplevel'])
  return out ? out.trim() : null
}

/** origin/HEAD when it is set, else the first of main/master that exists, else the current branch. */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const head = await gitOrNull(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head.trim().replace(/^origin\//, '')

  for (const candidate of ['main', 'master']) {
    const found = await gitOrNull(repoPath, ['rev-parse', '--verify', '--quiet', candidate])
    if (found?.trim()) return candidate
  }
  const current = await gitOrNull(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return current?.trim() || 'main'
}

export async function currentBranch(cwd: string): Promise<string> {
  const out = await gitOrNull(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out?.trim() || 'HEAD'
}

/**
 * The primary clone behind a linked worktree. `--git-common-dir` points at the main repo's .git,
 * so its parent is the repo root.
 */
export async function mainRepoPath(worktreePath: string): Promise<string | null> {
  const out = await gitOrNull(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const gitDir = out?.trim()
  if (!gitDir) return null
  return gitDir.endsWith('/.git') ? gitDir.slice(0, -'/.git'.length) : null
}

export interface WorktreeEntry {
  path: string
  branch: string
  isMain: boolean
}

/** Every worktree of a repo, primary clone first, as reported by git itself. */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const out = await gitOrNull(repoPath, ['worktree', 'list', '--porcelain'])
  if (!out) return []

  const entries: WorktreeEntry[] = []
  let current: { path?: string; branch?: string } = {}
  const flush = (): void => {
    if (current.path) {
      entries.push({
        path: current.path,
        branch: current.branch ?? 'HEAD',
        isMain: entries.length === 0
      })
    }
    current = {}
  }

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  flush()
  return entries
}

/** Commits on local branches that no remote has — what deleting the clone would lose for good. */
export async function unpushedCommitCount(repoPath: string): Promise<number> {
  const out = await gitOrNull(repoPath, ['rev-list', '--count', '--branches', '--not', '--remotes'])
  return out ? Number(out.trim()) || 0 : 0
}

export async function stashCount(repoPath: string): Promise<number> {
  const out = await gitOrNull(repoPath, ['stash', 'list'])
  return out ? out.split('\n').filter(Boolean).length : 0
}

export async function dirtyCount(worktreePath: string): Promise<number> {
  const out = await gitOrNull(worktreePath, ['status', '--porcelain'])
  return out ? out.split('\n').filter(Boolean).length : 0
}

/** Local heads, most recently committed first. */
export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await gitOrNull(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/heads'
  ])
  return out
    ? out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
}

/**
 * Remote-tracking heads, most recently committed first — `origin/fix-login` and the like.
 *
 * `origin/HEAD` is dropped: it is a symbolic ref pointing at the remote's default branch, so it is
 * never a branch of its own, only a second name for one already in the list.
 */
export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  const out = await gitOrNull(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/remotes'
  ])
  return out
    ? out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith('/HEAD'))
    : []
}

/**
 * The branch part of a remote-tracking ref: `origin/feature/login` → `feature/login`. Safe as a
 * split on the first segment because git forbids `/` in a remote's name.
 */
export function localNameOf(remoteRef: string): string {
  return remoteRef.split('/').slice(1).join('/')
}

/** Where a name actually lives — refs/heads/x, refs/remotes/origin/x — or null if it resolves to neither. */
export async function fullRef(repoPath: string, ref: string): Promise<string | null> {
  const out = await gitOrNull(repoPath, ['rev-parse', '--symbolic-full-name', ref])
  return out?.trim() || null
}

export async function isRemoteRef(repoPath: string, ref: string): Promise<boolean> {
  const full = await fullRef(repoPath, ref)
  return Boolean(full?.startsWith('refs/remotes/'))
}

/**
 * Refreshes remote-tracking refs, so a branch a colleague pushed since the last fetch is offered
 * rather than missing. Best-effort by design: no remote, no network, or an auth prompt leaves the
 * refs exactly as they were, and the caller carries on with what is already known.
 *
 * The timeout is the point of the direct exec — a fetch that hangs on credentials would otherwise
 * never settle, and this runs while a dialog is open waiting for it.
 */
export async function fetchRemotes(repoPath: string): Promise<boolean> {
  try {
    await exec('git', ['fetch', '--all', '--prune', '--quiet'], {
      cwd: repoPath,
      maxBuffer: MAX_BUFFER,
      timeout: 20_000
    })
    return true
  } catch {
    return false
  }
}

/** Whether a ref exists at all — a local branch, a remote-tracking one, a tag or a commit. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const out = await gitOrNull(repoPath, ['rev-parse', '--verify', '--quiet', branch])
  return Boolean(out?.trim())
}

/**
 * Whether a ref's tree carries a path — asked of the commit, not of any checkout, so it answers for
 * a worktree that does not exist yet. Which is the question the new-session dialog has: whether the
 * worktree it is about to cut from this base will come with a setup script in it.
 */
export async function pathExistsAtRef(
  repoPath: string,
  ref: string,
  relPath: string
): Promise<boolean> {
  return (await gitOrNull(repoPath, ['cat-file', '-e', `${ref}:${relPath}`])) !== null
}

/**
 * Creates a worktree on a new branch cut from `base`.
 * Returns the branch actually used — a numeric suffix is appended if the name was taken.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
  base: string
): Promise<string> {
  let finalBranch = branch
  let n = 2
  while (await branchExists(repoPath, finalBranch)) {
    finalBranch = `${branch}-${n++}`
  }
  await git(repoPath, ['worktree', 'add', '-b', finalBranch, worktreePath, base])
  return finalBranch
}

/**
 * Removes a worktree. `force` is opt-in: without it git refuses when the tree holds modified or
 * untracked files, which is the safety net we want — `--force` destroys uncommitted work with no
 * stash and no dangling objects to recover from.
 *
 * The branch is deleted after the worktree, never before: git refuses to delete a branch that is
 * still checked out somewhere.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  deleteBranch: boolean,
  force: boolean
): Promise<{ commands: string[] }> {
  const commands: string[] = []

  const args = force
    ? ['worktree', 'remove', '--force', worktreePath]
    : ['worktree', 'remove', worktreePath]
  commands.push(`git ${args.join(' ')}`)
  await git(repoPath, args)

  if (deleteBranch) {
    commands.push(`git branch -D ${branch}`)
    await git(repoPath, ['branch', '-D', branch])
  }

  commands.push('git worktree prune')
  await gitOrNull(repoPath, ['worktree', 'prune'])
  return { commands }
}

/** Stashes tracked and untracked changes. Stashes live in the common git dir, so any worktree of
 * the repo can pop them — which is what makes moving work between worktrees possible. */
export async function stashPush(worktreePath: string, message: string): Promise<void> {
  await git(worktreePath, ['stash', 'push', '-u', '-m', message])
}

export async function stashPop(worktreePath: string): Promise<void> {
  await git(worktreePath, ['stash', 'pop'])
}

/**
 * Stashes and returns the stash's commit. Naming the commit rather than a stack position matters
 * because stack indices shift as other stashes are pushed and popped, while the commit is stable —
 * so an archived session can still find its own work months later.
 */
export async function stashPushRef(worktreePath: string, message: string): Promise<string | null> {
  await stashPush(worktreePath, message)
  const out = await gitOrNull(worktreePath, ['rev-parse', 'stash@{0}'])
  return out?.trim() || null
}

/** Applies a stash by commit, leaving it in the stash list in case the restore is repeated. */
export async function stashApplyRef(worktreePath: string, ref: string): Promise<void> {
  await git(worktreePath, ['stash', 'apply', ref])
}

/**
 * Moves off the current branch without changing a single file: HEAD points at the same commit, so
 * the working tree — including uncommitted changes — is untouched, and the branch becomes free for
 * another worktree to check out.
 */
export async function detachHead(worktreePath: string): Promise<void> {
  await git(worktreePath, ['checkout', '--detach'])
}

export async function checkout(worktreePath: string, ref: string): Promise<void> {
  await git(worktreePath, ['checkout', ref])
}

/** Adds a worktree for a branch that already exists. */
export async function addWorktreeForBranch(
  repoPath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await git(repoPath, ['worktree', 'add', worktreePath, branch])
}

/**
 * Adds a worktree on a new local branch that tracks a remote one — the local half of a branch that
 * so far exists only on the remote.
 *
 * `--track` is what makes this continuing that branch rather than forking it: the upstream is set,
 * so a later push updates the same remote branch and ahead/behind is measured against it.
 */
export async function addWorktreeTracking(
  repoPath: string,
  worktreePath: string,
  branch: string,
  remoteRef: string
): Promise<void> {
  await git(repoPath, ['worktree', 'add', '--track', '-b', branch, worktreePath, remoteRef])
}

export async function isDetached(worktreePath: string): Promise<boolean> {
  const out = await gitOrNull(worktreePath, ['symbolic-ref', '--quiet', 'HEAD'])
  return !out?.trim()
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await gitOrNull(repoPath, ['worktree', 'prune'])
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await gitOrNull(repoPath, ['branch', '-D', branch])
}

/** Renames a branch in place, worktree and all. Only safe while nothing else refers to it. */
export async function renameBranch(repoPath: string, from: string, to: string): Promise<void> {
  await git(repoPath, ['branch', '-m', from, to])
}

/**
 * Whether the branch exists anywhere but locally. Renaming one that has been pushed leaves the
 * remote copy behind under the old name — the local branch stops tracking it, and an open PR keeps
 * pointing at a branch nothing updates any more. So this gates the automatic rename.
 *
 * Both halves are needed: a branch pushed with -u has an upstream ref, one pushed without it has
 * only a remote-tracking ref.
 */
export async function isPublished(repoPath: string, branch: string): Promise<boolean> {
  const upstream = await gitOrNull(repoPath, [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${branch}`
  ])
  if (upstream?.trim()) return true
  const tracking = await gitOrNull(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/remotes/*/${branch}`
  ])
  return Boolean(tracking?.trim())
}

/** Worktrees that currently have `branch` checked out. */
export async function checkedOutAt(repoPath: string, branch: string): Promise<string[]> {
  const entries = await listWorktrees(repoPath)
  return entries.filter((entry) => entry.branch === branch).map((entry) => entry.path)
}

function splitPath(p: string): { name: string; dir: string } {
  const name = basename(p)
  const dir = dirname(p)
  return { name, dir: dir === '.' ? '' : dir }
}

function kindFromStatus(code: string): ChangeKind {
  const c = code[0]
  if (c === 'A') return 'A'
  if (c === 'D') return 'D'
  if (c === 'R') return 'R'
  if (c === 'M') return 'M'
  return 'M'
}

async function countLines(path: string): Promise<number> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > UNTRACKED_COUNT_LIMIT) return 0
    const text = await readFile(path, 'utf8')
    if (text.length === 0) return 0
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
  } catch {
    return 0
  }
}

/**
 * The session's changes: everything the worktree has that the base branch does not,
 * committed or not, plus untracked files. Scoped from the merge-base so an out-of-date
 * base branch does not show up as the session's own work.
 */
export async function status(worktreePath: string, baseBranch: string): Promise<GitStatus> {
  const branch = await currentBranch(worktreePath)

  const mergeBaseOut = await gitOrNull(worktreePath, ['merge-base', 'HEAD', baseBranch])
  const mergeBase = mergeBaseOut?.trim() || null

  const files = new Map<string, ChangedFile>()

  if (mergeBase) {
    const nameStatus = await gitOrNull(worktreePath, [
      'diff',
      '--name-status',
      '-z',
      mergeBase,
      '--'
    ])
    if (nameStatus) {
      const parts = nameStatus.split('\0').filter(Boolean)
      for (let i = 0; i < parts.length; ) {
        const code = parts[i++]
        if (!code) break
        // Renames and copies carry two paths.
        const isRenameOrCopy = code[0] === 'R' || code[0] === 'C'
        const from = parts[i++] ?? ''
        const to = isRenameOrCopy ? (parts[i++] ?? from) : from
        const path = to
        const { name, dir } = splitPath(path)
        files.set(path, { path, name, dir, kind: kindFromStatus(code), insertions: 0, deletions: 0 })
      }
    }

    const numstat = await gitOrNull(worktreePath, ['diff', '--numstat', '-z', mergeBase, '--'])
    if (numstat) {
      // -z numstat: "<add>\t<del>\t" then NUL-separated path(s).
      const chunks = numstat.split('\0')
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        if (!chunk) continue
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(chunk)
        if (!m) continue
        const add = m[1] === '-' ? 0 : Number(m[1])
        const del = m[2] === '-' ? 0 : Number(m[2])
        let path = m[3]
        if (path === '') {
          // Rename: the old and new paths follow as separate NUL-delimited fields.
          const oldPath = chunks[++i] ?? ''
          path = chunks[++i] ?? oldPath
        }
        const existing = files.get(path)
        if (existing) {
          existing.insertions = add
          existing.deletions = del
        } else {
          const { name, dir } = splitPath(path)
          files.set(path, { path, name, dir, kind: 'M', insertions: add, deletions: del })
        }
      }
    }
  }

  const untracked = await gitOrNull(worktreePath, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z'
  ])
  if (untracked) {
    for (const path of untracked.split('\0').filter(Boolean)) {
      if (files.has(path)) continue
      const { name, dir } = splitPath(path)
      files.set(path, {
        path,
        name,
        dir,
        kind: 'A',
        insertions: await countLines(join(worktreePath, path)),
        deletions: 0
      })
    }
  }

  let ahead = 0
  let behind = 0
  const counts = await gitOrNull(worktreePath, [
    'rev-list',
    '--left-right',
    '--count',
    `${baseBranch}...HEAD`
  ])
  if (counts) {
    const [b, a] = counts.trim().split(/\s+/).map(Number)
    behind = Number.isFinite(b) ? b : 0
    ahead = Number.isFinite(a) ? a : 0
  }

  const list = [...files.values()].sort((x, y) => x.path.localeCompare(y.path))
  return {
    branch,
    ahead,
    behind,
    files: list,
    insertions: list.reduce((sum, f) => sum + f.insertions, 0),
    deletions: list.reduce((sum, f) => sum + f.deletions, 0),
    landing: await landing(worktreePath, branch, baseBranch)
  }
}

/**
 * Reflog entries that put a commit of the branch's own at its tip. What is left out is every way
 * the branch can come to point at somebody else's commit: being created, renamed, reset, or
 * fast-forwarded onto the base. Counting those would call a branch landed that never was.
 */
const OWN_TIP =
  /^(commit|cherry-pick|revert)\b|^(rebase|pull)\b.*\(finish\)|^(merge|pull)\b.*Merge made/

/**
 * How far past the base branch a session's branch is, or where its work landed.
 *
 * The reflog rather than ancestry: a branch rebased onto main or with main merged in has main's
 * commits in its history, and those are on main without the session's work being there. A tip the
 * branch itself committed is the session's own, and once one is on the base, the work landed.
 */
export async function branchSync(
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<BranchSync> {
  const counts = await gitOrNull(worktreePath, [
    'rev-list',
    '--count',
    `${baseBranch}..refs/heads/${branch}`
  ])
  return {
    ahead: Number(counts?.trim()) || 0,
    landing: await landing(worktreePath, branch, baseBranch)
  }
}

async function landing(
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<Landing | null> {
  const log = await gitOrNull(worktreePath, [
    'reflog',
    'show',
    '--format=%H %gs',
    `refs/heads/${branch}`,
    '--'
  ])
  if (!log) return null
  const entries = log.split('\n').filter(Boolean)
  const tips = new Set(
    entries
      .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)])
      // A rebase with nothing of its own to replay finishes on the commit it went onto.
      .filter(([hash, message]) => OWN_TIP.test(message) && !message.endsWith(`onto ${hash}`))
      .map(([hash]) => hash)
  )
  if (tips.size === 0) return null
  // The oldest entry is where the branch began, so the base's commits from before it are skipped.
  const start = entries[entries.length - 1].slice(0, 40)

  for (const [where, ref] of [
    ['remote', `origin/${baseBranch}`],
    ['local', baseBranch]
  ] as const) {
    const onBase = await gitOrNull(worktreePath, [
      'rev-list',
      '--max-count=5000',
      ref,
      `^${start}`,
      '--'
    ])
    if (!onBase?.split('\n').some((hash) => tips.has(hash))) continue
    const after = await gitOrNull(worktreePath, [
      'rev-list',
      '--count',
      '--no-merges',
      `${ref}..refs/heads/${branch}`
    ])
    return {
      where,
      ref,
      commitsAfter: Number(after?.trim()) || 0,
      filesAfter: await dirtyCount(worktreePath)
    }
  }
  return null
}

export async function recentCommits(worktreePath: string, limit: number): Promise<Commit[]> {
  const out = await gitOrNull(worktreePath, [
    'log',
    `-${limit}`,
    '--pretty=format:%h%x00%s',
    '--no-merges'
  ])
  if (!out) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split('\0')
      return { hash, subject: subject ?? '' }
    })
}

/** Paths git currently reports as conflicted. */
export async function conflicts(worktreePath: string): Promise<string[]> {
  const out = await gitOrNull(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z'])
  return out ? out.split('\0').filter(Boolean) : []
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const out = await gitOrNull(worktreePath, ['status', '--porcelain'])
  return Boolean(out?.trim())
}

/**
 * Brings the session branch up to date with base. Leaves the worktree mid-operation on
 * conflict so the user can resolve in the editor or hand it to Claude.
 */
export async function integrate(
  worktreePath: string,
  baseBranch: string,
  mode: MergeMode
): Promise<{ ok: boolean; conflicts: string[]; message: string }> {
  if (await hasUncommittedChanges(worktreePath)) {
    return {
      ok: false,
      conflicts: [],
      message: 'Commit or stash the working tree before integrating.'
    }
  }
  try {
    if (mode === 'rebase') {
      await git(worktreePath, ['rebase', baseBranch])
    } else {
      await git(worktreePath, ['merge', '--no-ff', baseBranch])
    }
    return { ok: true, conflicts: [], message: '' }
  } catch (err) {
    const list = await conflicts(worktreePath)
    const stderr = err instanceof GitError ? err.stderr : String(err)
    return {
      ok: false,
      conflicts: list,
      message: list.length
        ? `${list.length} conflicted file${list.length === 1 ? '' : 's'}`
        : stderr.split('\n')[0] || 'Integration failed'
    }
  }
}

/**
 * Fast-forwards the base branch onto the session branch.
 *
 * Two strategies, because neither covers everything. `merge --ff-only` needs the base checked out
 * in the worktree it runs in; `fetch . <branch>:<base>` needs the base checked out *nowhere* — it
 * refuses with "refusing to fetch into branch ... checked out at". Together they handle both the
 * normal case and a session that occupies the primary clone on a feature branch.
 */
export async function landOnBase(
  repoPath: string,
  baseBranch: string,
  branch: string
): Promise<{ ok: boolean; message: string; command: string }> {
  const holders = await checkedOutAt(repoPath, baseBranch)

  try {
    if (holders.length === 0) {
      const command = `git fetch . ${branch}:${baseBranch}`
      await git(repoPath, ['fetch', '.', `${branch}:${baseBranch}`])
      return { ok: true, message: '', command }
    }

    // Run the merge inside whichever worktree holds the base branch.
    const command = `git -C ${holders[0]} merge --ff-only ${branch}`
    await git(holders[0], ['merge', '--ff-only', branch])
    return { ok: true, message: '', command }
  } catch (err) {
    const stderr = err instanceof GitError ? err.stderr : String(err)
    return { ok: false, message: stderr.split('\n')[0] || 'Merge failed', command: '' }
  }
}

/** Stages and commits everything in a worktree — the "commit first" escape before archiving. */
export async function commitAll(
  worktreePath: string,
  message: string
): Promise<{ ok: boolean; error: string; commands: string[] }> {
  const commands = ['git add -A', `git commit -m ${JSON.stringify(message)}`]
  try {
    await git(worktreePath, ['add', '-A'])
    await git(worktreePath, ['commit', '-m', message])
    return { ok: true, error: '', commands }
  } catch (err) {
    const stderr = err instanceof GitError ? err.stderr : String(err)
    return { ok: false, error: stderr.split('\n')[0] || 'Commit failed', commands }
  }
}

export async function push(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ['push', '-u', 'origin', branch])
}

export async function remoteUrl(cwd: string): Promise<string | null> {
  const out = await gitOrNull(cwd, ['remote', 'get-url', 'origin'])
  return out ? out.trim() : null
}

/** owner/name parsed out of an origin URL, for the PR dialog's subtitle. */
export function parseRemote(url: string | null): string | null {
  if (!url) return null
  const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(url.trim())
  return m ? m[1] : null
}

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, maxBuffer: MAX_BUFFER })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    throw new GitError(`gh ${args[0]} failed: ${e.message}`, e.stderr ?? '')
  }
}

export async function ghAvailable(): Promise<boolean> {
  try {
    await exec('gh', ['--version'])
    return true
  } catch {
    return false
  }
}

export async function createPullRequest(
  worktreePath: string,
  branch: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<{ ok: boolean; url: string; number: number | null; message: string }> {
  try {
    await push(worktreePath, branch)
    const out = await gh(worktreePath, [
      'pr',
      'create',
      '--base',
      baseBranch,
      '--head',
      branch,
      '--title',
      title,
      '--body',
      body
    ])
    const url = out.trim().split('\n').pop() ?? ''
    const num = /\/pull\/(\d+)/.exec(url)
    return { ok: true, url, number: num ? Number(num[1]) : null, message: '' }
  } catch (err) {
    const stderr = err instanceof GitError ? err.stderr : String(err)
    return { ok: false, url: '', number: null, message: stderr.split('\n')[0] || 'PR creation failed' }
  }
}

function checkState(bucket: string | undefined, state: string | undefined): CheckState {
  const v = (bucket ?? state ?? '').toLowerCase()
  if (v === 'pass' || v === 'success') return 'passed'
  if (v === 'fail' || v === 'failure' || v === 'error' || v === 'cancelled') return 'failed'
  if (v === 'pending' || v === 'queued' || v === 'in_progress') return 'pending'
  return 'none'
}

export async function prStatus(worktreePath: string, branch: string): Promise<PrStatus | null> {
  try {
    const out = await gh(worktreePath, [
      'pr',
      'view',
      branch,
      '--json',
      'number,url,statusCheckRollup'
    ])
    const data = JSON.parse(out) as {
      number: number
      url: string
      statusCheckRollup?: { name?: string; context?: string; conclusion?: string; state?: string }[]
    }
    return {
      number: data.number,
      url: data.url,
      checks: (data.statusCheckRollup ?? []).map((c) => ({
        name: c.name ?? c.context ?? 'check',
        state: checkState(c.conclusion, c.state)
      }))
    }
  } catch {
    return null
  }
}
