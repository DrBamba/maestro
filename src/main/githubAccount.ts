import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AccountGuess, GithubAccounts } from '@shared/types'

const exec = promisify(execFile)

/**
 * Which GitHub account a repo works as, for someone logged into several with `gh auth login`.
 *
 * Kept in the repo's **local** git config, beside the per-repo `user.email` it pairs with, rather
 * than in a committed `.maestro/` file: the account is the person's, not the repo's, and a teammate
 * who cloned a committed `DrBamba` would be handed someone else's login. Local config is shared by
 * every worktree of the repo, so one setting covers sessions that already exist.
 *
 * Two things follow the setting:
 *  - `git` itself, through a credential helper written into the same local config. That reaches
 *    every push and fetch — Maestro's, an agent's, or one typed in a terminal outside Maestro.
 *  - `gh`, which reads no git config, through `GH_TOKEN` in the environment of Maestro's own `gh`
 *    calls and of every agent and terminal it starts in the repo.
 */
export const ACCOUNT_KEY = 'maestro.githubAccount'
const HELPER_KEY = 'credential.https://github.com.helper'
/** Matches the helpers this module writes, and nothing a person set up by hand. */
const OURS = '^$|gh auth token --hostname github.com --user'

/** GitHub logins are alphanumerics and single hyphens — checked because one goes into a shell line. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * Answers `get` with the account's token from gh's keyring, and ignores `store`/`erase` — gh owns
 * the token, so there is nothing for git to save or forget. Looked up per request rather than
 * copied in, so the config never holds a secret and a re-login is picked up at once.
 */
function helperFor(login: string): string {
  return (
    `!f() { test "$1" = get || return 0; ` +
    `printf 'username=%s\\npassword=%s\\n' ${login} ` +
    `"$(gh auth token --hostname github.com --user ${login})"; }; f`
  )
}

async function gitConfig(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['config', ...args], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

/** The account set for the repo `cwd` belongs to, or null to leave gh's active account in charge. */
export async function repoAccount(cwd: string): Promise<string | null> {
  const value = await gitConfig(cwd, ['--local', '--get', ACCOUNT_KEY])
  return value && LOGIN.test(value) ? value : null
}

/** Logins `gh auth login` has stored for github.com, the active one marked. */
export async function githubAccounts(): Promise<{ login: string; active: boolean }[] | null> {
  try {
    const { stdout } = await exec('gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'])
    const data = JSON.parse(stdout) as {
      hosts?: Record<string, { login?: string; active?: boolean; state?: string }[]>
    }
    return (data.hosts?.['github.com'] ?? [])
      .filter((a) => a.login && a.state === 'success')
      .map((a) => ({ login: a.login as string, active: a.active === true }))
  } catch {
    return null
  }
}

export async function describeAccounts(cwd: string): Promise<GithubAccounts> {
  const [accounts, current] = await Promise.all([githubAccounts(), repoAccount(cwd)])
  return { accounts, current }
}

/**
 * Sets or clears the repo's account. Only the helpers this module wrote are removed, so a helper
 * someone configured for the repo by hand survives both directions.
 *
 * Clearing writes an empty value rather than removing the key: "gh default" is a choice someone
 * made, and {@link guessRepoAccount} only guesses for a repo where no choice was ever recorded.
 */
export async function setRepoAccount(repoPath: string, login: string | null): Promise<void> {
  if (login !== null && !LOGIN.test(login)) throw new Error(`Not a GitHub login: ${login}`)
  await gitConfig(repoPath, ['--local', '--unset-all', HELPER_KEY, OURS])
  const set = async (args: string[]): Promise<void> => {
    await exec('git', ['config', '--local', ...args], { cwd: repoPath })
  }
  await set([ACCOUNT_KEY, login ?? ''])
  if (login === null) return
  // The empty entry resets the helper list, so the keychain's saved login never answers first.
  await set(['--add', HELPER_KEY, ''])
  await set(['--add', HELPER_KEY, helperFor(login)])
}

/**
 * `GH_TOKEN` for the repo's account, or nothing when none is set or gh no longer has it — in
 * which case gh's active account applies, exactly as before the setting existed. Read fresh each
 * time, so a re-login is picked up without a restart.
 */
export async function githubEnv(cwd: string): Promise<Record<string, string>> {
  const login = await repoAccount(cwd)
  if (!login) return {}
  const token = await tokenFor(login)
  return token ? { GH_TOKEN: token } : {}
}

async function tokenFor(login: string): Promise<string | null> {
  try {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** `owner` and `name` of a github.com remote, over https or ssh; null for anything else. */
export function githubRepoOf(url: string): { owner: string; name: string } | null {
  const match = url
    .trim()
    .match(
      /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/
    )
  return match ? { owner: match[1], name: match[2] } : null
}

/** Whether GitHub says `login` may push to the repo. Any failure — offline, no access — is a no. */
async function canPush(login: string, repo: { owner: string; name: string }): Promise<boolean> {
  const token = await tokenFor(login)
  if (!token) return false
  try {
    const { stdout } = await exec(
      'gh',
      ['api', `repos/${repo.owner}/${repo.name}`, '--jq', '.permissions.push'],
      { env: { ...process.env, GH_TOKEN: token }, timeout: 10_000 }
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * The account a repo cloned outside Maestro most likely belongs to, for a repo where nobody has
 * picked one — not even "gh default". Git records nothing about who cloned, so it is read off
 * GitHub instead: the one logged-in account that can push, or of several, the repo's owner.
 *
 * Null means there is nothing to decide: a choice is already recorded, the remote is not on
 * GitHub, or there are fewer than two accounts to choose between.
 */
export async function guessRepoAccount(cwd: string): Promise<AccountGuess | null> {
  if ((await gitConfig(cwd, ['--local', '--get', ACCOUNT_KEY])) !== null) return null
  let url = ''
  try {
    url = (await exec('git', ['remote', 'get-url', 'origin'], { cwd })).stdout
  } catch {
    return null
  }
  const repo = githubRepoOf(url)
  if (!repo) return null
  const logins = (await githubAccounts())?.map((a) => a.login) ?? []
  if (logins.length === 0) return null

  const pushes = await Promise.all(logins.map((login) => canPush(login, repo)))
  const pushers = logins.filter((_, i) => pushes[i])
  if (pushers.length === 1) return { login: pushers[0] }
  const owner = pushers.find((l) => l.toLowerCase() === repo.owner.toLowerCase())
  if (owner) return { login: owner }
  if (logins.length < 2) return null
  return pushers.length > 1 ? { choose: pushers, why: 'several' } : { choose: logins, why: 'none' }
}

/** Paths already guessed for this run, so a repo nobody can settle is not asked about per session. */
const guessed = new Set<string>()

/**
 * Records the guessed account when it is certain, once per repo per run. Returns what is left to
 * ask, for the caller that can ask.
 */
export async function adoptGuessedAccount(cwd: string): Promise<AccountGuess | null> {
  if (guessed.has(cwd)) return null
  guessed.add(cwd)
  const guess = await guessRepoAccount(cwd)
  if (guess && 'login' in guess) await setRepoAccount(cwd, guess.login)
  return guess
}

/**
 * The URL `git clone` gets: `owner/name` means GitHub, anything else is passed through as typed —
 * a URL, an ssh address or a local path.
 */
export function cloneUrl(source: string): string {
  const typed = source.trim()
  const short = typed.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/)
  return short ? `https://github.com/${short[1]}/${short[2]}.git` : typed
}

/** The folder name `git clone` would pick for a source. */
export function cloneName(source: string): string {
  return cloneUrl(source)
    .replace(/[/:]+$/, '')
    .split(/[/:]/)
    .pop()!
    .replace(/\.git$/, '')
}

/**
 * Clones as `login`, through the same per-request helper the repo keeps afterwards, so a private
 * repo is fetched with that account's token instead of whatever the keychain answers first.
 */
export async function cloneAs(source: string, dest: string, login: string | null): Promise<void> {
  if (login !== null && !LOGIN.test(login)) throw new Error(`Not a GitHub login: ${login}`)
  const helper = login ? ['-c', `${HELPER_KEY}=`, '-c', `${HELPER_KEY}=${helperFor(login)}`] : []
  await exec('git', [...helper, 'clone', '--', cloneUrl(source), dest], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}
