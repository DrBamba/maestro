import type { Locator, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * Whether a session's work is on main, pushed or not, and what happened on it since. Read off git,
 * so a merge made in a terminal shows the same as one made through Maestro's own dialog.
 */

async function createSession(window: Page, name: string, base?: string): Promise<void> {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', name)
  if (base) await window.selectOption('#session-base', base)
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
  await expect(mark.locator('.sync__after')).not.toHaveClass(/is-pushed/)
  await expect(row(window, 'version route')).not.toHaveClass(/is-landed/)

  // Pushing what came after tells it apart from work that is only local.
  await exec('git', ['push', '-q', 'origin', session.branch], { cwd: session.path })
  await expect(mark.locator('.sync__after')).toHaveClass(/is-pushed/, { timeout: 15_000 })
  await expect(window.locator('.session__header .push-chip')).toHaveText('Pushed · not merged')
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

test('a pushed branch shows it is waiting to be merged', async ({ window, profileDir }) => {
  await withOrigin(profileDir)
  await createSession(window, 'rate limit')
  const session = await sessionNamed(window, 'rate limit')
  const mark = row(window, 'rate limit').locator('.sync')
  const chip = window.locator('.session__header .push-chip')

  await commit(session.path, 'limits.py')
  await expect(mark).toHaveText('1', { timeout: 15_000 })
  await expect(mark).not.toHaveClass(/is-pushed/)
  await expect(chip).toHaveCount(0)

  await exec('git', ['push', '-q', '-u', 'origin', session.branch], { cwd: session.path })
  await expect(mark).toHaveClass(/is-pushed/, { timeout: 15_000 })
  await expect(chip).toHaveText('Pushed · not merged')

  // A commit after the push is still local, and says so.
  await commit(session.path, 'burst.py')
  await expect(chip).toHaveText('1 commit not pushed', { timeout: 15_000 })
  await expect(mark).not.toHaveClass(/is-pushed/)
  await expect(mark).toHaveText('2')
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

test('a session cut from another counts only its own work, until the other lands', async ({
  window,
  profileDir
}) => {
  const repoPath = await withOrigin(profileDir)
  await createSession(window, 'search api')
  const parent = await sessionNamed(window, 'search api')
  await commit(parent.path, 'search.py')
  await commit(parent.path, 'index.py')
  await expect(row(window, 'search api').locator('.sync')).toHaveText('2', { timeout: 15_000 })

  await createSession(window, 'search ui', parent.branch)
  const child = await sessionNamed(window, 'search ui')
  const mark = row(window, 'search ui').locator('.sync')
  // Every open session keeps its view mounted; the active one is the one showing.
  const meta = window.locator('.session__header .session__meta').filter({ visible: true })
  const base = meta.locator('.session__base')

  // The parent's two commits are the parent's: the child starts at nothing, against the parent.
  await expect(base).toHaveText(parent.branch, { timeout: 15_000 })
  await expect(meta).toContainText('↑0 ↓0')
  await expect(meta).toContainText('0 files changed')
  await expect(mark).toHaveCount(0)

  await commit(child.path, 'results.py')
  await expect(mark).toHaveText('1', { timeout: 15_000 })
  await expect(meta).toContainText('↑1 ↓0')
  await expect(meta).toContainText('1 file changed')

  // The parent moving on puts the child behind it, not ahead.
  await commit(parent.path, 'ranking.py')
  await expect(meta).toContainText('↑1 ↓1', { timeout: 15_000 })

  // Once what the child took from the parent is on main, main is its base again — and still only
  // the child's own commit counts.
  await exec('git', ['merge', '-q', '--ff-only', parent.branch], { cwd: repoPath })
  await expect(base).toHaveCount(0, { timeout: 15_000 })
  await expect(mark).toHaveText('1')
  await expect(meta).toContainText('↑1 ↓1')
})

test('merging a session cut from another lands it on that one, not main', async ({
  window,
  profileDir
}) => {
  const repoPath = await withOrigin(profileDir)
  await createSession(window, 'export csv')
  const parent = await sessionNamed(window, 'export csv')
  await commit(parent.path, 'export.py')

  await createSession(window, 'export button', parent.branch)
  const child = await sessionNamed(window, 'export button')
  await commit(child.path, 'button.py')
  await expect(row(window, 'export button').locator('.sync')).toHaveText('1', { timeout: 15_000 })

  await window.keyboard.press('ControlOrMeta+k')
  await window.fill('.palette__input', 'Merge into')
  await expect(window.locator('.palette')).toContainText(`Merge into ${parent.branch}`)
  await window.keyboard.press('Enter')
  await expect(window.locator('.modal__title')).toHaveText(`Merge into ${parent.branch}`)
  await window.click(`button:has-text("Rebase onto ${parent.branch}")`)
  await expect(window.locator('.modal__title')).toHaveCount(0, { timeout: 15_000 })

  const log = async (ref: string): Promise<string> =>
    (await exec('git', ['log', '--format=%s', ref], { cwd: repoPath })).stdout
  expect(await log(parent.branch)).toContain('Add button.py')
  expect(await log('main')).not.toContain('Add button.py')
  // The parent's worktree holds its branch, so the landing fast-forwarded the files there too.
  expect(existsSync(join(parent.path, 'button.py'))).toBe(true)
})

test('a session cut before its base was recorded finds it after a restart', async ({
  window,
  profileDir,
  relaunch
}) => {
  await withOrigin(profileDir)
  await createSession(window, 'audit log')
  const parent = await sessionNamed(window, 'audit log')
  await commit(parent.path, 'audit.py')
  await createSession(window, 'audit filters', parent.branch)

  // What a session made by an older Maestro looks like: no base on the record.
  const storeFile = join(profileDir, 'maestro.json')
  const next = await relaunch(async () => {
    const data = JSON.parse(await readFile(storeFile, 'utf8')) as {
      sessions: { name: string; base?: string }[]
    }
    delete data.sessions.find((s) => s.name === 'audit filters')!.base
    await writeFile(storeFile, JSON.stringify(data), 'utf8')
  })

  // Read back from the reflog entry the cut left.
  await expect
    .poll(() =>
      next.evaluate(async () => {
        const snapshot = await window.maestro.snapshot()
        return snapshot.sessions.find((s) => s.name === 'audit filters')?.base
      })
    )
    .toBe(parent.branch)
  await next.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(row(next, 'audit log').locator('.sync')).toHaveText('1', { timeout: 15_000 })
  await expect(row(next, 'audit filters').locator('.sync')).toHaveCount(0)
})
