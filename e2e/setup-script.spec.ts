import type { Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * A repo's setup script is `.maestro/setup.sh`, committed to the repo — so these tests write real
 * files into the demo repos and assert on what a real worktree does with them.
 *
 * demo-web ships one, committed by the seeder, which is what carries it into every worktree cut from
 * it. demo-api ships none, and is where a test that wants a particular script commits its own.
 */

function repoPath(profileDir: string, name: string): string {
  return join(profileDir, 'demo-repos', name)
}

/** Commits a repo's setup script, the way writing one in a worktree and merging it ends up. */
async function commitSetupScript(
  profileDir: string,
  repo: string,
  body: string
): Promise<string> {
  const path = repoPath(profileDir, repo)
  await mkdir(join(path, '.maestro'), { recursive: true })
  const script = join(path, '.maestro', 'setup.sh')
  await writeFile(script, body, { encoding: 'utf8', mode: 0o755 })
  await exec('git', ['add', '-A'], { cwd: path })
  await exec('git', ['commit', '-qm', 'Add setup script'], { cwd: path })
  return script
}

/** Creates a session with an opening message, which is what makes Claude start *working*. */
async function createSession(window: Page, name: string, repo: string): Promise<void> {
  await window.click(`[aria-label="New session in ${repo}"]`)
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText(name, { timeout: 30_000 })
}

/** The worktree of the session the app currently has open. */
function worktreeOf(window: Page): Promise<string> {
  return window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions[0].worktreePath))
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  return stdout.trim()
}

async function hasCodeServer(): Promise<boolean> {
  try {
    await exec('which', ['code-server'])
    return true
  } catch {
    return false
  }
}

/** What the embedded workbench is currently loading — the only place a payload URL is observable. */
function embedUrl(window: Page): Promise<string> {
  return window.evaluate(() => {
    const view = document.querySelector('webview') as { getURL?: () => string } | null
    return view?.getURL?.() ?? ''
  })
}

test('the dialog reads the base ref, not the repo', async ({ window, profileDir }) => {
  const found = async (repo: string): Promise<boolean> =>
    window.evaluate(async (name) => {
      const snapshot = await window.maestro.snapshot()
      const repoId = snapshot.repos.find((r) => r.name === name)!.id
      return window.maestro.repos.setupScriptAt(repoId, 'main')
    }, repo)

  expect(await found('demo-web')).toBe(true)
  expect(await found('demo-api')).toBe(false)

  // Committed to main after the app started, and the answer follows the commit — it is the tree being
  // checked out that decides, not anything Maestro recorded when the repo was added.
  await commitSetupScript(profileDir, 'demo-api', '#!/usr/bin/env bash\necho hi\n')
  expect(await found('demo-api')).toBe(true)
})

test('the session writes a setup script into its own worktree', async ({ window }) => {
  await createSession(window, 'write a setup script', 'demo-api')
  const worktree = await worktreeOf(window)
  const script = join(worktree, '.maestro', 'setup.sh')
  expect(existsSync(script)).toBe(false)

  // What the header button and ⌘K → "Edit setup script" both call.
  const first = await window.evaluate(() =>
    window.maestro
      .snapshot()
      .then((s) => window.maestro.sessions.setupScript(s.sessions[0].id))
  )
  expect(first.error).toBeUndefined()
  expect(first.created).toBe(true)
  // In the worktree, where it can be committed — not in the primary clone.
  expect(first.path).toBe(script)
  expect(await readFile(script, 'utf8')).toMatch(/^#!\/usr\/bin\/env bash/)

  // Asked for twice it opens what is there, rather than overwriting what was written into it.
  await writeFile(script, '#!/usr/bin/env bash\necho mine\n', 'utf8')
  const second = await window.evaluate(() =>
    window.maestro
      .snapshot()
      .then((s) => window.maestro.sessions.setupScript(s.sessions[0].id))
  )
  expect(second.created).toBe(false)
  expect(await readFile(script, 'utf8')).toContain('echo mine')
})

test('the header button opens the script in the session editor', async ({ window }) => {
  test.skip(!(await hasCodeServer()), 'code-server is not installed on this machine')
  // Only a running workbench can be asked what it is loading, and a fresh profile installs three
  // extensions before code-server may start — usually seconds, occasionally not.
  test.setTimeout(120_000)
  await createSession(window, 'edit the setup script', 'demo-api')

  await window.click('[aria-label="Setup script"]')
  await expect(window.locator('.tab.is-on')).toHaveText(/Editor/)
  expect(existsSync(join(await worktreeOf(window), '.maestro', 'setup.sh'))).toBe(true)

  /*
   * The workbench is asked for that file even though the request arrived before code-server had
   * started — the first `openFile` of a session always does, and it used to be dropped, which looked
   * from outside like the Editor tab opening on nothing in particular.
   */
  await expect
    .poll(() => embedUrl(window), { timeout: 90_000, intervals: [500] })
    .toContain('setup.sh')
})

test('the template it writes does not switch the directive on', async ({ window }) => {
  // The template explains `# maestro: background` in prose, and prose about a directive must not be
  // read as the directive — a new script that quietly held nothing back would be a strange default.
  await createSession(window, 'template check', 'demo-api')
  const session = await window.evaluate(async () => {
    const snapshot = await window.maestro.snapshot()
    const repo = snapshot.repos.find((r) => r.name === 'demo-api')!
    // Written into a worktree, committed, and then read by the *next* worktree cut from it.
    await window.maestro.sessions.setupScript(snapshot.sessions[0].id)
    return { repoId: repo.id, worktree: snapshot.sessions[0].worktreePath }
  })

  await exec('git', ['add', '-A'], { cwd: session.worktree })
  await exec('git', ['commit', '-qm', 'Add setup script'], { cwd: session.worktree })
  const cut = await window.evaluate(
    ({ repoId, branch }) => window.maestro.sessions.create(repoId, 'from the template', branch),
    { repoId: session.repoId, branch: await currentBranch(session.worktree) }
  )
  expect(cut.session?.setupState).toBe('pending')
  expect(cut.session?.setupBackground).toBeFalsy()
})

test('a committed setup script runs in the worktree it made', async ({ window }) => {
  // demo-web's script is committed by the seeder, so the worktree carries its own copy.
  await createSession(window, 'setup from file', 'demo-web')
  await expect(window.locator('.tab.is-on')).toHaveText('setup')
  await expect(window.locator('.setup-state')).toHaveText('setup ✓', { timeout: 30_000 })
  expect(existsSync(join(await worktreeOf(window), '.maestro', 'setup.sh'))).toBe(true)
})

test('a script only on another branch does not reach this worktree', async ({
  window,
  profileDir
}) => {
  // Committed on a branch of its own, so main — which this session is cut from — carries none.
  const clone = repoPath(profileDir, 'demo-api')
  await exec('git', ['checkout', '-qb', 'has-setup'], { cwd: clone })
  await commitSetupScript(profileDir, 'demo-api', '#!/usr/bin/env bash\necho ran > setup-ran.txt\n')
  await exec('git', ['checkout', '-q', 'main'], { cwd: clone })

  // Cut from main by name rather than through the dialog, which would offer `has-setup` too.
  const cut = await window.evaluate(async () => {
    const snapshot = await window.maestro.snapshot()
    const repo = snapshot.repos.find((r) => r.name === 'demo-api')!
    return window.maestro.sessions.create(repo.id, 'no script on main', 'main')
  })
  expect(cut.error).toBeUndefined()
  // Nothing in the tree to build, so nothing is pending and nothing ran.
  expect(cut.session?.setupState).toBe('ok')
  expect(existsSync(join(cut.session!.worktreePath, '.maestro'))).toBe(false)
  expect(existsSync(join(cut.session!.worktreePath, 'setup-ran.txt'))).toBe(false)
})

test("setup holds Claude's first turn, and the script can release it", async ({
  window,
  profileDir,
  agentLog
}) => {
  await commitSetupScript(profileDir, 'demo-api', '#!/usr/bin/env bash\nsleep 4\n')
  await createSession(window, 'held for setup', 'demo-api')

  // Still setting up, so the opening turn has not been handed to Claude — an agent working in a
  // worktree with no dependencies installed is what the hold exists to prevent.
  await expect(window.locator('.setup-state')).toHaveText('setup running')
  expect(await agentLog()).toBe('')

  // …and it is released by setup finishing, either way.
  await expect(window.locator('.setup-state')).toHaveText('setup ✓', { timeout: 30_000 })
  await expect.poll(agentLog, { timeout: 20_000 }).toContain('held for setup')
})

test('a background setup script does not hold anything up', async ({
  window,
  profileDir,
  agentLog
}) => {
  await commitSetupScript(
    profileDir,
    'demo-api',
    '#!/usr/bin/env bash\n# maestro: background\nsleep 4\n'
  )
  await createSession(window, 'not held', 'demo-api')

  // Claude has the prompt while the script is still going, which is the whole of the directive.
  await expect.poll(agentLog, { timeout: 20_000 }).toContain('not held')
  await expect(window.locator('.setup-state')).toHaveText('setup running')
})

test('setup can be run again in the worktree you are in', async ({ window, profileDir }) => {
  await commitSetupScript(
    profileDir,
    'demo-api',
    '#!/usr/bin/env bash\necho run >> setup-runs.txt\n'
  )
  await createSession(window, 'run setup again', 'demo-api')
  await expect(window.locator('.setup-state')).toHaveText('setup ✓', { timeout: 30_000 })

  const runs = join(await worktreeOf(window), 'setup-runs.txt')
  expect((await readFile(runs, 'utf8')).trim().split('\n')).toHaveLength(1)

  // What ⌘K → "Run setup script" dispatches. Trying the script where it was written is the point.
  await window.evaluate(() =>
    window.maestro.snapshot().then((s) =>
      window.dispatchEvent(
        new CustomEvent('maestro:setup-script', {
          detail: { sessionId: s.sessions[0].id, action: 'run' }
        })
      )
    )
  )
  await expect(window.locator('.setup-state')).toHaveText('setup ✓', { timeout: 30_000 })
  await expect
    .poll(async () => (await readFile(runs, 'utf8')).trim().split('\n').length, { timeout: 20_000 })
    .toBe(2)
})

test('asking to run setup where there is none says so', async ({ window }) => {
  await createSession(window, 'nothing to run', 'demo-api')
  await window.evaluate(() =>
    window.maestro.snapshot().then((s) =>
      window.dispatchEvent(
        new CustomEvent('maestro:setup-script', {
          detail: { sessionId: s.sessions[0].id, action: 'run' }
        })
      )
    )
  )
  // Said, rather than opening a setup tab on a process with nothing to do.
  await expect(window.locator('.toast')).toContainText('No setup script here')
  await expect(window.locator('.tab:has-text("setup")')).toHaveCount(0)
})

test('setup interrupted by a quit runs again on relaunch', async ({
  window,
  profileDir,
  relaunch
}) => {
  await commitSetupScript(profileDir, 'demo-api', '#!/usr/bin/env bash\necho done\n')
  await createSession(window, 'setup resumed', 'demo-api')
  await expect(window.locator('.setup-state')).toHaveText('setup ✓', { timeout: 30_000 })

  /*
   * What a quit mid-script leaves behind: `running`, for a pty that died with the app. Left alone it
   * would never run again and anything waiting on it would wait forever.
   */
  const next = await relaunch(async () => {
    const file = join(profileDir, 'maestro.json')
    const data = JSON.parse(await readFile(file, 'utf8'))
    data.sessions[0].setupState = 'running'
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
  })

  await next.click('.session-row')
  await expect(next.locator('.setup-state')).toHaveText('setup ✓', { timeout: 30_000 })
})
