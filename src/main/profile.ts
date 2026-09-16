import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

const exec = promisify(execFile)

/**
 * Which data directory this instance uses.
 *
 * Maestro is developed from its own checkout, so a packaged "stable" copy and a `npm run dev` copy
 * are routinely open at once. They must not share state: everything that matters lives under
 * userData — the session store, the agent-state files the hooks write, and the embedded VS Code's
 * profile — and two instances writing one `maestro.json` would clobber each other's sessions and
 * could launch two Claudes in the same worktree.
 *
 * So an unpackaged run gets its own directory. The consequence is deliberate: a dev instance starts
 * with no repos and cannot disturb real work. Set MAESTRO_USER_DATA_DIR to point somewhere specific
 * — including the stable directory — when testing against real sessions is the actual goal.
 */
export type Profile = 'stable' | 'dev' | 'custom'

let current: Profile = 'stable'
let stableUserData = ''

/** Must run before anything reads userData, so before app.whenReady(). */
export function configureProfile(): Profile {
  const override = process.env.MAESTRO_USER_DATA_DIR
  if (override) {
    app.setPath('userData', override)
    current = 'custom'
  } else if (!app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), 'maestro-dev'))
    current = 'dev'
  } else {
    current = 'stable'
  }

  /*
   * Where the installed copy keeps its sessions — spelled out rather than read from userData before
   * the redirect above, because the default is derived from the app's name and the name depends on
   * how the app was started: `electron out/main/index.js` finds no package.json beside the entry
   * point and calls itself "Electron". Named here, alongside the dev directory it is the sibling of.
   *
   * And only a plain dev run may look at it — see resolveSourceLabel, the one thing that reads it.
   * An explicit MAESTRO_USER_DATA_DIR is a promise that this directory is the whole of what the
   * instance can see, which the e2e suite depends on to stay off the real session file.
   */
  if (current === 'dev') stableUserData = join(app.getPath('appData'), 'maestro')

  /*
   * Rename the app itself, not just something inside the window. Two Maestros side by side are
   * otherwise indistinguishable in the dock, the app switcher and the menu bar — which is exactly
   * where you look when deciding which window you are about to type into. userData is already set
   * explicitly above, so renaming cannot move it.
   */
  if (current !== 'stable') app.setName(current === 'dev' ? 'Maestro Dev' : 'Maestro (custom)')

  return current
}

export function profile(): Profile {
  return current
}

let source = ''

/**
 * Names the checkout this instance is running out of.
 *
 * Maestro is developed from its own worktrees, so several dev instances can be open at once, each
 * built from a different session. "dev" is true of all of them and therefore identifies none.
 *
 * The branch does not identify them either: it is minted from a random handle, so every one of
 * them reads `feature/<two-words>` and telling `feature/brief-cedar` from `feature/quiet-ember`
 * means remembering which was which. The session's name is the sentence the work was started
 * with, which is the thing actually worth seeing — so look it up, and fall back to the branch
 * only for a checkout no session claims.
 *
 * Empty when packaged: the app bundle is not a checkout, and the installed copy needs no marker.
 */
export async function resolveSourceLabel(): Promise<string> {
  if (app.isPackaged) return ''
  const path = app.getAppPath()
  source = (await sessionName(path)) || (await gitLabel(path))
  return source
}

/**
 * The name the owning session gave this worktree.
 *
 * Looked up in this instance's own store first and the stable one second. A dev run normally has
 * only the second: its data directory is its own, and the one session it is missing is precisely
 * the one that produced the checkout it is running from. But an instance pointed at a populated
 * directory already holds the answer, and its own record is the one to believe.
 *
 * Read-only either way — the stable file belongs to another instance, which is free to be writing
 * it at this moment.
 */
async function sessionName(appPath: string): Promise<string> {
  for (const dir of new Set([app.getPath('userData'), stableUserData].filter(Boolean))) {
    try {
      const raw = await readFile(join(dir, 'maestro.json'), 'utf8')
      const parsed = JSON.parse(raw) as { sessions?: { name?: string; worktreePath?: string }[] }
      // The app path is the checkout root in dev, but a build could run from inside it.
      const owner = parsed.sessions?.find(
        (s) =>
          !!s.worktreePath &&
          (appPath === s.worktreePath || appPath.startsWith(`${s.worktreePath}/`))
      )
      const name = owner?.name?.trim()
      if (name) return name
    } catch {
      // No store there, or not readable — try the next one.
    }
  }
  return ''
}

/*
 * The branch, falling back to the checkout — not to the app path. `electron out/main/index.js`
 * reports its app path as the directory holding that file, so the fallback named the instance
 * "main", which reads as a branch and is one of the few labels guaranteed to be wrong. Git is still
 * asked from the app path, since it searches upwards and lands in the right repository either way.
 */
async function gitLabel(appPath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', appPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 3000
    })
    const branch = stdout.trim()
    // A detached HEAD says nothing useful; the directory name at least locates it.
    return branch && branch !== 'HEAD' ? branch : basename(process.cwd())
  } catch {
    return basename(process.cwd())
  }
}

export function sourceLabel(): string {
  return source
}
