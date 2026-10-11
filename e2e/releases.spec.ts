import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'

/**
 * Updating a running Maestro. A release is a build copied into `<userData>/releases/<id>` with
 * `current` pointed at it — what `npm run release` does, and what the update button runs. The builds
 * here are this checkout's own `out/`, with the window changed in a way a test can see.
 */

test.use({
  appEnv: {
    MAESTRO_RELEASES: '1',
    MAESTRO_WINDOW_DEADLINE_MS: '4000',
    MAESTRO_NO_RELAUNCH: '1',
    // Deliberately slower than the tests wait: what notices `main` moving is the watch on its ref.
    MAESTRO_UPDATE_POLL_MS: '120000',
    MAESTRO_UPDATE_FETCH_MS: '2000'
  }
})

async function createSession(window: Page, name: string): Promise<void> {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText(name, { timeout: 30_000 })
}

function starts(log: string): number {
  return log.split('\n').filter((line) => line.startsWith('ARGS:')).length
}

/**
 * Publishes `out/` as a release, with its window's page passed through `page` — and, with
 * `changeMain`, a main process that differs too, which cannot be applied by a reload.
 */
async function publish(
  profileDir: string,
  id: string,
  page: (html: string) => string,
  changeMain = false,
  source?: { repo: string; commit: string }
): Promise<void> {
  const releases = join(profileDir, 'releases')
  const bundle = join(releases, id)
  await mkdir(releases, { recursive: true })
  await cp('out', bundle, { recursive: true })

  const index = join(bundle, 'renderer', 'index.html')
  await writeFile(index, page(await readFile(index, 'utf8')))

  const stamp = JSON.parse(await readFile(join(bundle, 'release.json'), 'utf8'))
  stamp.id = id
  stamp.subject = `test release ${id}`
  stamp.builtAt += 60_000
  stamp.hashes.renderer = `changed-${id}`
  if (changeMain) stamp.hashes.main = `changed-${id}`
  if (source) Object.assign(stamp, source)
  await writeFile(join(bundle, 'release.json'), JSON.stringify(stamp))

  await writeFile(join(releases, 'current.partial'), id)
  await rename(join(releases, 'current.partial'), join(releases, 'current'))
}

const marker = (html: string): string =>
  html.replace('<head>', '<head><meta name="maestro-test-release" content="yes">')

const updateButton = (window: Page) => window.locator('.sidebar__update .btn:has-text("Update Maestro")')

async function hasMarker(window: Page): Promise<boolean> {
  return window.evaluate(() => !!document.querySelector('meta[name="maestro-test-release"]'))
}

test('a release that only changes the window is applied live, agents untouched', async ({
  window,
  profileDir,
  agentLog
}) => {
  await createSession(window, 'live window update')
  await expect.poll(async () => starts(await agentLog()), { timeout: 15_000 }).toBe(1)
  expect(await hasMarker(window)).toBe(false)

  await publish(profileDir, '20990101-000000-window', marker)

  // Offered, not applied.
  await expect(updateButton(window)).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(2000)
  expect(await hasMarker(window)).toBe(false)
  await updateButton(window).click()

  await expect.poll(() => hasMarker(window).catch(() => false), { timeout: 20_000 }).toBe(true)
  await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
  await expect(window.locator('.toast')).toContainText('Maestro updated')
  await expect(window.locator('.session-row__name').first()).toHaveText('live window update')

  // The same Claude, still connected.
  await window.locator('.session:visible .term:visible').first().click()
  await window.keyboard.type('after the update')
  await window.keyboard.press('Enter')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('after the update')
  expect(starts(await agentLog())).toBe(1)

  await expect
    .poll(() => readFile(join(profileDir, 'releases', 'last-good'), 'utf8').catch(() => ''))
    .toBe('20990101-000000-window')
})

test('a release whose window never comes up is backed out', async ({ window, profileDir }) => {
  await createSession(window, 'broken update')

  // A page that loads but never starts the app.
  await publish(profileDir, '20990101-000000-broken', () => '<!doctype html><title>broken</title>')
  await updateButton(window).click()

  await expect
    .poll(() => readFile(join(profileDir, 'releases', 'bad'), 'utf8').catch(() => ''), {
      timeout: 30_000
    })
    .toContain('20990101-000000-broken')
  await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
  await expect(window.locator('.session-row__name').first()).toHaveText('broken update')
})

test('a release that never reached a working window is skipped at the next launch', async ({
  window,
  profileDir,
  relaunch
}) => {
  await publish(profileDir, '20990101-000000-stuck', marker)
  await updateButton(window).click()
  await expect.poll(() => hasMarker(window).catch(() => false), { timeout: 20_000 }).toBe(true)

  // As a crash during start-up would leave it.
  const next = await relaunch(async () => {
    await writeFile(join(profileDir, 'releases', 'booting'), '20990101-000000-stuck')
    await writeFile(join(profileDir, 'releases', 'last-good'), '')
  })

  expect(await readFile(join(profileDir, 'releases', 'bad'), 'utf8')).toContain('20990101-000000-stuck')
  expect(await hasMarker(next)).toBe(false)
})

test('a release that changes main relaunches the app around its running agents', async ({
  window,
  profileDir,
  agentLog,
  relaunch
}) => {
  await createSession(window, 'main update')
  await expect.poll(async () => starts(await agentLog()), { timeout: 15_000 }).toBe(1)

  await publish(profileDir, '20990101-000000-main', marker, true)
  await updateButton(window).click()
  const next = await relaunch(undefined, 'exited')

  expect(await hasMarker(next)).toBe(true)
  await expect(next.locator('.toast')).toContainText('Maestro updated')
  await expect(next.locator('.launcher')).toHaveCount(0)
  await next.locator('.session:visible .term:visible').first().click()
  await next.keyboard.type('after the relaunch')
  await next.keyboard.press('Enter')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('after the relaunch')
  expect(starts(await agentLog())).toBe(1)
  await expect
    .poll(() => readFile(join(profileDir, 'releases', 'last-good'), 'utf8').catch(() => ''))
    .toBe('20990101-000000-main')
})

test('a release that needs a new terminal host offers a restart instead', async ({
  window,
  profileDir,
  relaunch
}) => {
  await publish(profileDir, '20990101-000000-host', marker)
  const stampFile = join(profileDir, 'releases', '20990101-000000-host', 'release.json')
  const stamp = JSON.parse(await readFile(stampFile, 'utf8'))
  await writeFile(stampFile, JSON.stringify({ ...stamp, hostProtocol: stamp.hostProtocol + 1 }))

  const restart = window.locator('.sidebar__update .btn:has-text("Restart to update")')
  await expect(restart).toBeVisible({ timeout: 20_000 })
  await expect(updateButton(window)).toHaveCount(0)
  await restart.click()

  // A real quit: nothing is running, so there is nothing to confirm.
  const next = await relaunch(undefined, 'exited')
  expect(await hasMarker(next)).toBe(true)
})

/**
 * Stands in for `scripts/release.mjs` in a scratch repository: reports the same steps, then
 * publishes a copy of the release it runs from as `main`'s commit — or fails in testing when the
 * repo's `stub-mode` file says so. The real script's pipeline is covered by running it; this is the
 * app's side of it.
 */
const RELEASE_STUB = `
import { cpSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
const releases = join(process.env.MAESTRO_USER_DATA_DIR, 'releases')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
console.log('$ npm run typecheck')
await sleep(800)
const testing = !process.argv.includes('--no-tests')
if (testing) console.log('$ npx playwright test')
await sleep(1500)
if (testing && readFileSync('stub-mode', 'utf8').trim() === 'fail') {
  console.error('\\nrelease: npx playwright test failed')
  process.exit(1)
}
const commit = execFileSync('git', ['rev-parse', 'main'], { encoding: 'utf8' }).trim()
const base = readFileSync(join(releases, 'current'), 'utf8').trim()
const id = '20990201-000000-' + commit.slice(0, 8)
cpSync(join(releases, base), join(releases, id), { recursive: true })
const stamp = JSON.parse(readFileSync(join(releases, id, 'release.json'), 'utf8'))
Object.assign(stamp, { id, commit, subject: 'built by the button', builtAt: stamp.builtAt + 1000 })
stamp.hashes.renderer = 'built-' + id
writeFileSync(join(releases, id, 'release.json'), JSON.stringify(stamp))
const index = join(releases, id, 'renderer', 'index.html')
writeFileSync(index, readFileSync(index, 'utf8').replace('<head>', '<head><meta name="maestro-built" content="yes">'))
writeFileSync(join(releases, 'current.partial'), id)
renameSync(join(releases, 'current.partial'), join(releases, 'current'))
console.log('release: published ' + id)
`

async function scratchRepo(profileDir: string): Promise<{ repo: string; commit: (msg: string) => string }> {
  const repo = join(profileDir, 'maestro-src')
  await mkdir(join(repo, 'scripts'), { recursive: true })
  await writeFile(join(repo, 'scripts', 'release.mjs'), RELEASE_STUB)
  await writeFile(join(repo, 'stub-mode'), 'pass')
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('add', 'scripts')
  const commit = (msg: string): string => {
    git('commit', '-q', '--allow-empty', '-m', msg)
    return git('rev-parse', 'HEAD')
  }
  return { repo, git, commit }
}

async function hasBuilt(window: Page): Promise<boolean> {
  return window.evaluate(() => !!document.querySelector('meta[name="maestro-built"]'))
}

/** Puts the app on a build of the scratch repo's first commit, so its later commits are updates. */
async function runFromScratchRepo(window: Page, profileDir: string) {
  const scratch = await scratchRepo(profileDir)
  const base = scratch.commit('base')
  await publish(profileDir, '20990101-000000-base', marker, false, { repo: scratch.repo, commit: base })
  await updateButton(window).click()
  await expect.poll(() => hasMarker(window).catch(() => false), { timeout: 20_000 }).toBe(true)
  await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
  await expect(window.locator('.sidebar__update')).toHaveCount(0)
  return scratch
}

test('new commits on main are offered, and the button builds, tests and applies them', async ({
  window,
  profileDir,
  agentLog
}) => {
  await createSession(window, 'button update')
  await expect.poll(async () => starts(await agentLog()), { timeout: 15_000 }).toBe(1)
  const scratch = await runFromScratchRepo(window, profileDir)

  scratch.commit('a new button')
  await expect(updateButton(window)).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('.sidebar__update-note')).toHaveText('1 change on main')

  await updateButton(window).click()
  await expect(window.locator('.sidebar__update')).toContainText('Testing update…', { timeout: 10_000 })
  await expect.poll(() => hasBuilt(window).catch(() => false), { timeout: 30_000 }).toBe(true)
  await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
  await expect(window.locator('.toast')).toContainText('built by the button')
  expect(starts(await agentLog())).toBe(1)
})

test('a build that fails its tests says so and can be retried', async ({ window, profileDir }) => {
  const scratch = await runFromScratchRepo(window, profileDir)
  await writeFile(join(scratch.repo, 'stub-mode'), 'fail')
  scratch.commit('a broken button')

  await updateButton(window).click()
  const bar = window.locator('.sidebar__update--failed')
  await expect(bar).toContainText('Tests failed on main', { timeout: 20_000 })
  // Stays up rather than being replaced by the next check.
  await window.waitForTimeout(2000)
  await expect(bar).toBeVisible()
  expect(await hasBuilt(window)).toBe(false)

  await writeFile(join(scratch.repo, 'stub-mode'), 'pass')
  await bar.locator('.btn:has-text("Retry update")').click()
  await expect.poll(() => hasBuilt(window).catch(() => false), { timeout: 30_000 }).toBe(true)
})

test('with tests skipped in settings, the button only builds main', async ({ window, profileDir }) => {
  const scratch = await runFromScratchRepo(window, profileDir)
  // Would fail if tested: skipping them is what lets it through.
  await writeFile(join(scratch.repo, 'stub-mode'), 'fail')
  scratch.commit('trusted main')

  await window.click('[aria-label="Settings"]')
  await window.click('[aria-label="Skip tests when updating"]')
  await window.keyboard.press('Escape')

  await updateButton(window).click()
  await expect(window.locator('.sidebar__update')).toContainText('Building update…', { timeout: 10_000 })
  await expect.poll(() => hasBuilt(window).catch(() => false), { timeout: 30_000 }).toBe(true)
})

test('an update finishing while a dialog is open waits for it to close', async ({
  window,
  profileDir
}) => {
  const scratch = await runFromScratchRepo(window, profileDir)
  scratch.commit('while typing')
  await updateButton(window).click()

  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'half typed')
  await expect(window.locator('.sidebar__update')).toContainText('Updating…', { timeout: 20_000 })
  await window.waitForTimeout(1500)
  expect(await hasBuilt(window)).toBe(false)
  await expect(window.locator('#session-name')).toHaveValue('half typed')

  await window.keyboard.press('Escape')
  await expect.poll(() => hasBuilt(window).catch(() => false), { timeout: 20_000 }).toBe(true)
})

test('with the setting on, a commit pushed to the remote is offered here', async ({
  window,
  profileDir
}) => {
  const scratch = await runFromScratchRepo(window, profileDir)

  // A remote, and somewhere else that pushes to it.
  const origin = join(profileDir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  scratch.git('remote', 'add', 'origin', origin)
  scratch.git('push', '-q', 'origin', 'main')

  const elsewhere = join(profileDir, 'elsewhere')
  const there = (...args: string[]): string =>
    execFileSync('git', ['-C', elsewhere, ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['clone', '-q', origin, elsewhere])
  there('config', 'user.email', 't@t')
  there('config', 'user.name', 't')
  there('commit', '-q', '--allow-empty', '-m', 'landed on the remote')
  there('push', '-q', 'origin', 'main')

  // Nothing here knows about it yet.
  await window.waitForTimeout(3000)
  await expect(window.locator('.sidebar__update')).toHaveCount(0)

  await window.click('[aria-label="Settings"]')
  await window.click('[aria-label="Fetch updates from the remote"]')
  await window.keyboard.press('Escape')

  await expect(updateButton(window)).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('.sidebar__update-note')).toHaveText('1 change on main')
  // Fast-forwarded rather than left behind, so the build and the repo agree on what main is.
  expect(scratch.git('rev-parse', 'main')).toBe(there('rev-parse', 'HEAD'))
})
