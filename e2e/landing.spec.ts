import type { Locator, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * Whether a session's work is on main, pushed or not, and what happened on it since. Read off git,
 * so a merge made in a terminal shows the same as one made through Maestro's own dialog.
 */

async function createSession(window: Page, name: string): Promise<void> {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(row(window, name)).toHaveClass(/is-active/, { timeout: 30_000 })
}

async function sessionNamed(window: Page, name: string): Promise<{ branch: string; path: string }> {
  return window.evaluate(async (wanted) => {
    const snapshot = await window.maestro.snapshot()
    const session = snapshot.sessions.find((s) => s.name === wanted)!
    return { branch: session.branch, path: session.worktreePath }
  }, name)
}

function row(window: Page, name: string): Locator {
  return window.locator('.session-row', {
    has: window.locator('.session-row__name', { hasText: name })
  })
}

async function commit(cwd: string, file: string): Promise<void> {
  await writeFile(join(cwd, file), `${file}\n`, 'utf8')
  await exec('git', ['add', '-A'], { cwd })
  await exec('git', ['commit', '-qm', `Add ${file}`], { cwd })
}

/** demo-api with a bare origin beside it, so there is a remote to push main to. */
async function withOrigin(profileDir: string): Promise<string> {
  const repoPath = join(profileDir, 'demo-repos', 'demo-api')
  const remotePath = join(profileDir, 'demo-api-origin.git')
  await exec('git', ['init', '-q', '--bare', remotePath])
  await exec('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath })
  await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repoPath })
  return repoPath
}

test('a session shows when its work lands on main, is pushed, and moves on', async ({
  window,
  profileDir
}) => {
  const repoPath = await withOrigin(profileDir)
  await createSession(window, 'version route')
  const session = await sessionNamed(window, 'version route')
  const mark = row(window, 'version route').locator('.sync')
  const chip = window.locator('.session__header .landing-chip')

  await commit(session.path, 'version.py')
  await expect(mark).toHaveText('1', { timeout: 15_000 })
  await expect(chip).toHaveCount(0)

  // Merged from a terminal, not the dialog: the state is git's, not Maestro's.
  await exec('git', ['merge', '-q', '--ff-only', session.branch], { cwd: repoPath })
  await expect(mark).toHaveClass(/is-local/, { timeout: 15_000 })
  await expect(chip).toHaveText('Merged into main · not pushed')

  await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repoPath })
  await expect(mark).toHaveClass(/is-remote/, { timeout: 15_000 })
  await expect(chip).toHaveText('On origin/main')
  await expect(row(window, 'version route')).toHaveClass(/is-landed/)

  // More work after landing is what is left to merge, so it is counted.
  await commit(session.path, 'changelog.md')
  await writeFile(join(session.path, 'notes.txt'), 'draft\n', 'utf8')
  await expect(chip).toHaveText('On origin/main+1 commit · 1 file since', { timeout: 15_000 })
  await expect(mark.locator('.sync__after')).toHaveText('+1')
  await expect(row(window, 'version route')).not.toHaveClass(/is-landed/)
})

test('a session that is not open still shows its landing in the sidebar', async ({
  window,
  profileDir
}) => {
  const repoPath = await withOrigin(profileDir)
  await createSession(window, 'health check')
  const first = await sessionNamed(window, 'health check')
  await commit(first.path, 'health.py')
  // A second session takes the header, so the first is only reached by the sidebar's own poll.
  await createSession(window, 'routes cleanup')

  await exec('git', ['merge', '-q', '--ff-only', first.branch], { cwd: repoPath })
  await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repoPath })
  await window.evaluate(() => window.dispatchEvent(new Event('focus')))

  await expect(row(window, 'health check').locator('.sync')).toHaveClass(/is-remote/, {
    timeout: 15_000
  })
  await expect(row(window, 'routes cleanup').locator('.sync')).toHaveCount(0)
})

test('rebasing onto main is not landing', async ({ window, profileDir }) => {
  const repoPath = await withOrigin(profileDir)
  await createSession(window, 'pagination')
  const session = await sessionNamed(window, 'pagination')
  await commit(session.path, 'pages.py')
  await commit(repoPath, 'unrelated.py')
  await exec('git', ['rebase', '-q', 'main'], { cwd: session.path })

  // The branch now has main's commits in it, which are on main without the session's being there.
  await expect(row(window, 'pagination').locator('.sync')).toHaveText('1', { timeout: 15_000 })
  await expect(window.locator('.session__header .landing-chip')).toHaveCount(0)
})
