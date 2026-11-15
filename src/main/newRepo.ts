import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import type { NewRepoOptions, Repo } from '@shared/types'
import * as git from './git'
import { setRepoAccount, tokenFor } from './githubAccount'
import { gitignoreFor, mitLicense, readmeFor } from './repoTemplates'
import { addRepo, expandHome } from './sessions'

const exec = promisify(execFile)

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

/** Git's last `fatal:`/`error:` line, or gh's last line — the part worth showing. */
function reason(err: unknown): string {
  const stderr = ((err as { stderr?: string }).stderr ?? '').trim()
  const lines = stderr.split('\n').filter(Boolean)
  return lines.filter((l) => /^(fatal|error):/.test(l)).pop() ?? lines.pop() ?? (err as Error).message
}

/**
 * Starts a repo: `git init` in the folder, the starter files asked for, the account's commit
 * identity, a first commit, and optionally the same repo on GitHub.
 *
 * The folder may already exist with work in it, as long as it is not a repo yet — then files it
 * already has are kept rather than replaced. Whatever this created is removed again if a local step
 * fails, so a failed attempt can simply be retried. A GitHub step that fails after the local repo
 * is made is reported as a warning instead: the repo is fine, only the remote is missing.
 */
export async function createRepo(opts: NewRepoOptions): Promise<{ repo: Repo; warning?: string } | { error: string }> {
  if (!opts.path.trim()) return { error: 'Which folder?' }
  const dest = resolve(expandHome(opts.path).replace(/\/+$/, ''))
  const name = basename(dest)
  const branch = opts.branch.trim() || 'main'
  try {
    await exec('git', ['check-ref-format', '--branch', branch])
  } catch {
    return { error: `${branch} is not a valid branch name.` }
  }
  if (opts.publish !== 'off' && !opts.login) return { error: 'Pick a GitHub account to create it on GitHub.' }

  const existed = await exists(dest)
  if (existed && (await exists(join(dest, '.git')))) {
    return { error: `${dest} is already a git repository. Add it as an existing folder.` }
  }
  // Inside another repo's tree, `git init` would nest a repo there — almost never what is wanted.
  const near = existed ? dest : dirname(dest)
  const outer = (await exists(near)) ? await git.repoRoot(near) : null
  if (outer) return { error: `${dest} is inside the repo at ${outer}.` }

  // Without an account to take an identity from, the commit needs the global one; checked before
  // anything is written, so the fix is one command and a retry.
  if (opts.commit && !opts.login) {
    try {
      await exec('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd: homedir() })
    } catch {
      return {
        error: 'Git has no name or email to commit with. Run `git config --global user.name` and `user.email`, or pick an account.'
      }
    }
  }

  const written: string[] = []
  const undo = async (): Promise<void> => {
    if (!existed) {
      await rm(dest, { recursive: true, force: true })
      return
    }
    await rm(join(dest, '.git'), { recursive: true, force: true })
    for (const file of written) await rm(file, { force: true })
  }

  try {
    await mkdir(dest, { recursive: true })
    await exec('git', ['init', '-q', '-b', branch], { cwd: dest })
    await setRepoAccount(dest, opts.login)

    const files: [string, () => Promise<string>][] = []
    if (opts.readme) files.push(['README.md', async () => readmeFor(name)])
    if (opts.gitignore !== 'none') {
      const template = opts.gitignore
      files.push(['.gitignore', async () => gitignoreFor(template)])
    }
    if (opts.license) files.push(['LICENSE', async () => mitLicense(await licenseHolder(dest), new Date().getFullYear())])
    for (const [file, content] of files) {
      const path = join(dest, file)
      if (await exists(path)) continue
      await writeFile(path, await content(), 'utf8')
      written.push(path)
    }

    if (opts.commit) {
      await exec('git', ['add', '-A'], { cwd: dest })
      // Nothing to add — an empty folder and no starter files — still gets the commit sessions branch from.
      const empty = (await readdir(dest)).every((f) => f === '.git')
      await exec('git', ['commit', '-q', ...(empty ? ['--allow-empty'] : []), '-m', 'Initial commit'], { cwd: dest })
    }
  } catch (err) {
    await undo()
    return { error: `Could not create ${name}. ${reason(err)}` }
  }

  let warning: string | undefined
  if (opts.publish !== 'off' && opts.login) warning = await publish(dest, name, opts)

  const added = await addRepo(dest)
  if ('error' in added) return added
  return { repo: added, warning }
}

/** The account's profile name the identity step just set, else the global one, else the folder's owner. */
async function licenseHolder(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['config', 'user.name'], { cwd })
    if (stdout.trim()) return stdout.trim()
  } catch {
    // Fall through.
  }
  return homedir().split('/').pop() ?? ''
}

/** `gh repo create` as the repo's account; returns what went wrong, or nothing. */
async function publish(dest: string, name: string, opts: NewRepoOptions): Promise<string | undefined> {
  const token = await tokenFor(opts.login!)
  if (!token) return `Created ${name} locally. ${opts.login} is no longer logged in to \`gh\`, so it is not on GitHub.`
  try {
    await exec(
      'gh',
      [
        'repo',
        'create',
        name,
        `--${opts.publish}`,
        '--source',
        dest,
        '--remote',
        'origin',
        ...(opts.commit ? ['--push'] : [])
      ],
      { cwd: dest, env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000 }
    )
    return undefined
  } catch (err) {
    return `Created ${name} locally, but not on GitHub. ${reason(err)}`
  }
}
