import type { Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test, expect, confirmDispose } from './fixtures'

const exec = promisify(execFile)

/**
 * The checkout the suite is launched from, resolved the same way the app resolves it.
 *
 * Naming a branch outright pinned the suite to one worktree — and since Maestro is developed from
 * several at once, that made a green run depend on which one you happened to be in.
 */
async function checkoutLabel(): Promise<string> {
  /*
   * The same rule the app implements, both halves of it: the branch, or the directory's name when
   * there is no branch to read. Only the first half was mirrored here, so anywhere the source is
   * not a working checkout — an export, a container, a tarball — the test failed on `git` while the
   * app was answering correctly.
   */
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    // Not a checkout.
  }
  return basename(process.cwd())
}

/**
 * Creates a session via the repo's own + button.
 *
 * Deliberately not the sidebar footer: that button adds a *repo* and opens a native folder picker,
 * which blocks the app with no DOM to drive.
 *
 * demo-api by default, because demo-web carries a setup script and therefore opens on its setup
 * tab — which is correct behaviour, but means the Claude terminal is not the focused one.
 */
async function createSession(window: Page, name: string, repo = 'demo-api'): Promise<void> {
  await window.click(`[aria-label="New session in ${repo}"]`)
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText(name, { timeout: 30_000 })
}

/** The class of whatever currently holds keyboard focus. */
function activeClass(window: Page): Promise<string> {
  return window.evaluate(() => document.activeElement?.className ?? '')
}

test('a dev profile seeds its demo repos and touches nothing real', async ({ window, profileDir }) => {
  // Local is a group heading too, so this asks for the repo ones specifically.
  const repos = window.locator('.repo-group:not(.repo-group--local) .repo-head__name')
  await expect(repos).toHaveCount(2)
  await expect(repos.nth(0)).toHaveText('demo-web')
  await expect(repos.nth(1)).toHaveText('demo-api')

  // Local sits above them: it is the way in when the work is not a branch.
  await expect(window.locator('.repo-head__name').first()).toHaveText('Local')

  // The marker names the checkout, which is what tells two dev windows apart.
  await expect(window.locator('.sidebar__profile')).toHaveText(await checkoutLabel())

  // The stronger claim than "not the stable root": everything this run writes is inside the
  // throwaway profile, so runs cannot collide with each other or with real worktrees.
  const worktreeRoot = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.worktreeRoot)
  )
  expect(profileDir).toContain('maestro-e2e-')
  expect(worktreeRoot.startsWith(profileDir)).toBe(true)
})

test('what you typed is handed to Claude as its first message', async ({ window, agentLog }) => {
  await createSession(window, 'fix the double page on the verdict list')

  // Asserted through the process: the prompt is an argv entry, so it never appears in the DOM and
  // never reaches the terminal's stdin either.
  await expect
    .poll(agentLog, { timeout: 20_000 })
    .toContain('ARGS: fix the double page on the verdict list')
})

test('an empty message opens Claude on its own prompt instead', async ({ window, agentLog }) => {
  await window.click('[aria-label="New session in demo-api"]')
  await window.click('.modal__actions .btn--primary')

  /*
   * The point of leaving it empty: no opening message is passed, so the first thing the user meets
   * is Claude's own input box — with every skill, file completion and shorthand it has, none of
   * which Maestro would have to reimplement in a textarea.
   *
   * Asserted as an argv line with nothing after it. The stub writes down what it was given, and a
   * prompt is the only positional argument there is.
   */
  await expect.poll(agentLog, { timeout: 30_000 }).toMatch(/^ARGS: *$/m)

  /*
   * And the session is nameable in the meantime. The handle the worktree was cut with stands in
   * until Claude titles the conversation, which is exactly what a session created *with* a message
   * gets once its title arrives — so the sidebar never shows a blank row.
   */
  await expect(window.locator('.session-row__name').first()).toHaveText(/^[a-z]+-[a-z]+$/)
})

test('Shift+Enter writes a second line rather than creating the session', async ({
  window,
  agentLog
}) => {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'rename the verdict list')

  /*
   * Enter is what creates the session, so an instruction longer than a sentence is only writable
   * here if Shift+Enter is spared. The dialog still being open is the assertion — a plain Enter at
   * that point would have closed it and started the work on half a sentence.
   */
  await window.press('#session-name', 'Shift+Enter')
  await window.keyboard.type('and keep the old route working')
  await expect(window.locator('.modal')).toBeVisible()

  // And the line break survives into the argv entry, because the prompt is passed as one argument.
  await window.press('#session-name', 'Enter')
  await expect
    .poll(agentLog, { timeout: 30_000 })
    .toContain('ARGS: rename the verdict list\nand keep the old route working')
})

test('auto mode, once chosen, is how Claude is launched', async ({
  window,
  agentLog,
  profileDir
}) => {
  await window.click('[aria-label="Settings"]')
  await window.click('.modal [aria-label="Start Claude in auto mode"]')
  await window.click('.modal__actions .btn--primary')

  await createSession(window, 'auto mode run')

  /*
   * Asserted as a whole argv string, which pins the order as well as the flag: the prompt is
   * positional, so a mode passed after it would be swallowed into the message instead of read as an
   * option. Nothing in the terminal could show this — the stub writes down what it was given.
   */
  await expect
    .poll(agentLog, { timeout: 20_000 })
    .toContain('ARGS: --permission-mode auto auto mode run')

  // A setting, not a one-off: it is on disk for the next launch to read.
  const stored = JSON.parse(await readFile(join(profileDir, 'maestro.json'), 'utf8'))
  expect(stored.preferences.permissionMode).toBe('auto')
})

test('the model and effort chosen when starting are how that session launches', async ({
  window,
  agentLog,
  profileDir
}) => {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'try it on haiku')
  await window.click('.modal .disclosure')
  await window.selectOption('#launch-model', 'haiku')
  await window.selectOption('#launch-effort', 'low')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('try it on haiku', {
    timeout: 30_000
  })

  // The whole argv string again, for the same reason auto mode asserts it: both flags have to land
  // ahead of the prompt, which is positional and would otherwise swallow them.
  await expect
    .poll(agentLog, { timeout: 20_000 })
    .toContain('ARGS: --model haiku --effort low try it on haiku')

  // Kept on the session rather than spent on the first launch, so every later launch matches it.
  const stored = JSON.parse(await readFile(join(profileDir, 'maestro.json'), 'utf8'))
  const session = stored.sessions.find((s: { name: string }) => s.name === 'try it on haiku')
  expect(session.model).toBe('haiku')
  expect(session.effort).toBe('low')
})

test('off, no mode is passed at all — Claude Code’s own settings decide', async ({
  window,
  agentLog
}) => {
  await createSession(window, 'default mode run')

  /*
   * The distinction the default rests on. Passing the default mode explicitly would look harmless
   * and would quietly override a defaultMode in the user's own .claude/settings.json, so the
   * untouched setting has to produce no flag rather than a neutral one.
   */
  await expect.poll(agentLog, { timeout: 20_000 }).toContain('ARGS: default mode run')
  expect(await agentLog()).not.toContain('--permission-mode')
})

test('the launcher offers that setting where Claude is actually started', async ({
  window,
  profileDir
}) => {
  // A folder that predates the session opens on the launcher rather than starting Claude itself.
  await window.click('[aria-label="New local session"]')
  await window.click('.seg__opt:has-text("One I already have")')
  await window.fill('#local-path', profileDir)
  await window.fill('#local-name', 'launcher settings')
  await window.click('.modal__actions .btn--primary')

  const box = window.locator('.launcher [aria-label="Start Claude in auto mode"] .checkbox__box')
  await expect(box).toBeVisible({ timeout: 30_000 })
  await expect(box).not.toHaveClass(/is-on/)

  await window.click('.launcher [aria-label="Start Claude in auto mode"]')
  await expect(box).toHaveClass(/is-on/)

  // The same setting seen from two places, not two copies of it: permission mode is app-wide, so
  // the box here and the one in Settings must never be able to disagree.
  await window.click('[aria-label="Settings"]')
  await expect(
    window.locator('.modal [aria-label="Start Claude in auto mode"] .checkbox__box')
  ).toHaveClass(/is-on/)
})

test('the worktree and branch take a short handle, not the typed text', async ({ window }) => {
  await createSession(window, 'fix the double page on the verdict list')

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )
  const handle = /^[a-z]+-[a-z]+$/
  expect(session.worktreePath.split('/').pop()).toMatch(handle)
  expect(session.branch).toMatch(/^feature\/[a-z]+-[a-z]+$/)
  /*
   * The point of the handle: the typed text is a sentence now, and the directory is the one name
   * that can never be corrected later — Claude Code keys its history by the absolute path.
   */
  expect(session.worktreePath).not.toContain('verdict')
})

test('a session can pick up an existing branch instead of stacking one on top', async ({
  window,
  profileDir
}) => {
  const repoPath = join(profileDir, 'demo-repos', 'demo-api')
  await exec('git', ['branch', 'spike/version-route'], { cwd: repoPath })

  await window.click('[aria-label="New session in demo-api"]')

  // main is checked out in the primary clone, and git allows one checkout per ref — so continuing
  // on it is refused in the dialog rather than at `git worktree add`.
  const box = window.locator('[aria-label="Continue on this branch"]')
  await expect(box).toBeDisabled()

  await window.selectOption('#session-base', 'spike/version-route')
  await expect(box).toBeEnabled()
  await box.click()
  await expect(box.locator('.checkbox__box')).toHaveClass(/is-on/)

  // Submitted with the message field empty: the branch already says what the work is, which is the
  // one place a session may be created without saying what it is building.
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('spike/version-route', {
    timeout: 30_000
  })

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )
  // The branch itself, not a new one cut from it — so there is nothing extra to merge back.
  expect(session.branch).toBe('spike/version-route')
  // And it is not Maestro's to delete or rename: it was here first.
  expect(session.branchOwned).toBe(false)
  expect(session.worktreePath.split('/').pop()).toBe('spike-version-route')
  expect(existsSync(join(session.worktreePath, 'server.py'))).toBe(true)

  // The same rule holds against the IPC call directly, not only against the disabled checkbox: the
  // branch this session now holds cannot be handed to a second worktree.
  const refused = await window.evaluate(async () => {
    const snapshot = await window.maestro.snapshot()
    const repo = snapshot.repos.find((r) => r.name === 'demo-api')!
    return window.maestro.sessions.create(repo.id, 'second try', 'spike/version-route', 'continue')
  })
  expect(refused.error).toContain('already checked out')
})

test('a branch that exists only on the remote can be picked up', async ({ window, profileDir }) => {
  const repoPath = join(profileDir, 'demo-repos', 'demo-api')
  const remotePath = join(profileDir, 'demo-api-remote.git')
  await exec('git', ['init', '-q', '--bare', remotePath])
  await exec('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath })
  await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repoPath })
  // Pushed straight to a ref this clone has no local branch for: exactly the shape of a colleague's
  // branch, which is the case the remote list exists for.
  await exec('git', ['push', '-q', 'origin', 'main:refs/heads/colleague/reporting'], {
    cwd: repoPath
  })

  await window.click('[aria-label="New session in demo-api"]')

  // The branch was pushed after the app started, so it is only offered because the dialog fetches.
  const option = window.locator('#session-base option[value="origin/colleague/reporting"]')
  await expect(option).toHaveCount(1, { timeout: 20_000 })
  await window.selectOption('#session-base', 'origin/colleague/reporting')

  const box = window.locator('[aria-label="Continue on this branch"]')
  await expect(box).toBeEnabled()
  await box.click()
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('colleague/reporting', {
    timeout: 30_000
  })

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )
  // A local half of the remote branch, not a fork of it…
  expect(session.branch).toBe('colleague/reporting')
  // …and tracking it, which is what makes a later push land on that same remote branch.
  const { stdout } = await exec(
    'git',
    ['rev-parse', '--abbrev-ref', 'colleague/reporting@{upstream}'],
    { cwd: session.worktreePath }
  )
  expect(stdout.trim()).toBe('origin/colleague/reporting')

  // Starting *from* a remote branch without continuing on it is still the default: a new branch cut
  // at that commit, owned by Maestro like any other.
  await exec('git', ['push', '-q', 'origin', 'main:refs/heads/colleague/exports'], { cwd: repoPath })
  const cut = await window.evaluate(async () => {
    const snapshot = await window.maestro.snapshot()
    const repo = snapshot.repos.find((r) => r.name === 'demo-api')!
    await window.maestro.repos.fetch(repo.id)
    return window.maestro.sessions.create(repo.id, 'chase the export numbers', 'origin/colleague/exports')
  })
  expect(cut.error).toBeUndefined()
  expect(cut.session?.branch).toMatch(/^feature\//)
  expect(cut.session?.branchOwned).toBe(true)
})

test('a repo with a setup script opens on its setup tab', async ({ window }) => {
  await createSession(window, 'setup run', 'demo-web')
  // The script's output is where the eye should land, so a failure is not silent.
  await expect(window.locator('.tab.is-on')).toHaveText('setup')
})

test('a repo without a setup script lands straight in Claude', async ({ window }) => {
  await createSession(window, 'no setup')
  await expect(window.locator('.tab.is-on')).toHaveText(/Claude/)
})

test('the Claude terminal takes focus and receives what is typed', async ({ window, agentLog }) => {
  await createSession(window, 'typing test')
  await expect(window.locator('.tab.is-on')).toHaveText(/Claude/)

  // xterm puts keyboard focus on its helper textarea; that is what "can type immediately" means.
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')

  await window.keyboard.type('hello from the test')
  await window.keyboard.press('Enter')

  // Asserted through the process, not the screen: xterm draws to a WebGL canvas, so terminal text
  // never appears in the DOM.
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('hello from the test')
})

test('switching to the Editor tab moves focus off the terminal', async ({ window }) => {
  await createSession(window, 'editor focus')
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')

  await window.click('.tab:has-text("Editor")')
  await expect(window.locator('.tab.is-on')).toHaveText(/Editor/)

  /*
   * Focus must leave the terminal. Where it lands depends on whether code-server is installed —
   * the webview when it is, the pane when it is not — so this asserts the part that is always true
   * rather than pretending to test the embed.
   */
  await expect
    .poll(() => activeClass(window), { timeout: 15_000 })
    .not.toContain('xterm-helper-textarea')
})

test('returning to Claude focuses it again', async ({ window }) => {
  await createSession(window, 'return focus')
  await window.click('.tab:has-text("Editor")')
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).not.toContain('xterm-helper')

  await window.click('.tab:has-text("Claude")')
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')
})

test('the Console tab runs a shell in the session directory', async ({ window }) => {
  await createSession(window, 'console cwd')

  await window.click('.tab:has-text("Console")')
  await expect(window.locator('.tab.is-on')).toHaveText(/Console/)
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )

  /*
   * Where the shell is standing, asserted through the filesystem: its output only ever reaches the
   * WebGL canvas. A relative redirect lands in the worktree exactly when the cwd is the worktree.
   */
  await window.keyboard.type('pwd > where-am-i.txt')
  await window.keyboard.press('Enter')

  const written = join(session.worktreePath, 'where-am-i.txt')
  await expect.poll(() => existsSync(written), { timeout: 20_000 }).toBe(true)
  // /var and /private/var are the same directory on macOS, so compare from the worktree root down.
  const printed = (await readFile(written, 'utf8')).trim()
  expect(printed.endsWith(session.worktreePath.replace(/^\/private/, ''))).toBe(true)
})

test('a second console is its own shell, and the first one keeps its scrollback', async ({
  window
}) => {
  await createSession(window, 'two consoles')
  await window.click('.tab:has-text("Console")')
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )

  await window.keyboard.type('echo one > one.txt')
  await window.keyboard.press('Enter')

  await window.click('[aria-label="New console"]')
  await expect(window.locator('.tab.is-on')).toHaveText(/Console 2/)
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')

  // Two shells, not one shared: what is typed here must not land in the tab that was open before.
  await window.keyboard.type('echo two > two.txt')
  await window.keyboard.press('Enter')

  await expect
    .poll(() => existsSync(join(session.worktreePath, 'one.txt')), { timeout: 20_000 })
    .toBe(true)
  await expect
    .poll(() => existsSync(join(session.worktreePath, 'two.txt')), { timeout: 20_000 })
    .toBe(true)
})

test('a console can be renamed, and closing one leaves the other alone', async ({ window }) => {
  await createSession(window, 'console names')
  await window.click('[aria-label="New console"]')
  await expect(window.locator('.tab.is-on')).toHaveText(/Console 2/)

  await window.dblclick('.tab:has-text("Console 2")')
  await window.fill('.tab__rename', 'server')
  await window.press('.tab__rename', 'Enter')
  await expect(window.locator('.tab.is-on')).toHaveText(/server/)

  // Escape leaves the name it found, rather than writing what was half-typed.
  await window.dblclick('.tab:has-text("server")')
  await window.fill('.tab__rename', 'not this')
  await window.press('.tab__rename', 'Escape')
  await expect(window.locator('.tab.is-on')).toHaveText(/server/)

  await window.click('.tab:has-text("server") .tab__close')
  await expect(window.locator('.tab:has-text("server")')).toHaveCount(0)
  await expect(window.locator('.tab:has-text("Console")')).toHaveCount(1)
})

test('every console can be closed, and the + brings one back', async ({ window }) => {
  await createSession(window, 'no consoles')
  await window.click('[aria-label="New console"]')
  await expect(window.locator('.tab:has-text("Console")')).toHaveCount(2)

  await window.click('.tab:has-text("Console 2") .tab__close')
  await window.click('.tab:has-text("Console") .tab__close')
  await expect(window.locator('.tab:has-text("Console")')).toHaveCount(0)
  // Nothing else goes with them: the panes that are always open are still there to fall back on.
  await expect(window.locator('.tab.is-on')).toHaveText(/Claude/)

  // The freed name is handed back rather than counting ever upwards.
  await window.click('[aria-label="New console"]')
  await expect(window.locator('.tab.is-on')).toHaveText(/^Console$/)
})

test('a repo stored before the run scripts existed still opens', async ({
  window,
  profileDir,
  relaunch
}) => {
  await createSession(window, 'old repo record')

  /*
   * The shape a repo added by an earlier Maestro has on disk: no run scripts, because the field did
   * not exist when it was written. It is read without a guard — `repo.runScripts.find` here and in
   * main — so one such record threw on the first render and put the crash card up in place of the
   * session.
   */
  const next = await relaunch(async () => {
    const file = join(profileDir, 'maestro.json')
    const store = JSON.parse(await readFile(file, 'utf8')) as {
      repos: Record<string, unknown>[]
    }
    for (const repo of store.repos) delete repo.runScripts
    await writeFile(file, JSON.stringify(store), 'utf8')
  })

  await expect(next.locator('.board__frame')).toHaveCount(1)
  await expect(next.locator('.crash')).toHaveCount(0)

  // Filled in on load, so nothing downstream has to know the record was ever short of it.
  const repos = await next.evaluate(() => window.maestro.snapshot().then((s) => s.repos))
  expect(repos.every((repo) => repo.runScripts.length === 0)).toBe(true)
})

test('the tag falls back to the branch when no session claims the checkout', async ({ window }) => {
  // A throwaway profile knows of no session living here, and it may not consult the real store —
  // so the branch is what is left to say which checkout this window was built from.
  const label = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sourceLabel)
  )
  expect(label).toBe(await checkoutLabel())
  await expect(window.locator('.sidebar__profile')).toHaveText(label)
})

test('the tag names the session that owns the checkout, in full on hover', async ({
  window,
  profileDir,
  relaunch
}) => {
  await expect(window.locator('.sidebar__profile')).toHaveText(await checkoutLabel())

  /*
   * Every dev branch is minted from a random handle, so `feature/<two words>` never says what a
   * window is for. The session that cut the worktree wrote down what it is for; the tag is that,
   * looked up by path — which is what the store is seeded with here, standing in for the instance
   * that would really have created it.
   */
  const name = 'Improve the dev tag so a window says which session it is'
  const next = await relaunch(async () => {
    const file = join(profileDir, 'maestro.json')
    const store = JSON.parse(await readFile(file, 'utf8'))
    store.sessions.push({
      id: 'owns-the-checkout',
      // Not any repo this profile has, so the sidebar has nothing to draw for it — the tag is the
      // only thing under test.
      repoId: 'elsewhere',
      name,
      branch: 'feature/brief-cedar',
      worktreePath: process.cwd(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      archived: false,
      setupState: 'ok',
      worktreeOwned: true,
      branchOwned: true,
      isPrimaryClone: false
    })
    await writeFile(file, JSON.stringify(store), 'utf8')
  })

  const tag = next.locator('.sidebar__profile')
  // The name is a sentence and the badge is a badge, so the tag is clipped by design — hovering is
  // how the whole of it is read, and that is the part a truncated label cannot be trusted for.
  await expect(tag).toHaveText(name)

  /*
   * The tag sits in the title bar, which is a drag region — that hands the pointer to the window
   * manager, so the badge received no hover of its own and no tooltip appeared however correct its
   * text was. Asserted as a property because Playwright synthesises its pointer events and would
   * hover the badge happily either way.
   */
  expect(
    await tag.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
  ).toBe('no-drag')

  await tag.hover()
  const tip = next.locator('.tooltip')
  // Promptly: the delay this replaced was close to a second, which read as nothing happening.
  await expect(tip).toContainText(name, { timeout: 600 })
  // The name leads and the kind of window follows, on its own line.
  await expect(tip.locator('.tooltip__hint')).toHaveText('Separate data directory')
  // And gone again when the pointer is elsewhere — a tooltip that outstays is worse than none.
  await next.locator('.sidebar__scroll').hover()
  await expect(tip).toHaveCount(0)
})

test('hovering a session too narrow for its name shows the whole of it', async ({ window }) => {
  const long = 'reconcile the billing webhook retries with the ledger'
  await createSession(window, long)
  // Not the helper: it reads the first row, and a second session lands under the first.
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'short one')
  await window.click('.modal__actions .btn--primary')

  const tip = window.locator('.tooltip')

  // A name the 264px sidebar can hold says nothing new on hover, so it gets no tip.
  await window.locator(`.session-row:has(.session-row__name:text-is("short one"))`).hover()
  await expect(tip).toHaveCount(0)

  const clipped = window.locator(`.session-row:has(.session-row__name:text-is("${long}"))`)
  const name = clipped.locator('.session-row__name')
  // The premise of the tip: the row really is showing less than the name.
  expect(
    await name.evaluate((el) => el.scrollWidth > el.clientWidth)
  ).toBe(true)

  await name.hover()
  await expect(tip).toHaveText(long)

  // And it goes when the pointer does — a tip left behind would cover the rows under it. Not the
  // wordmark: a dev window gives that row to its tag, so there is nothing there to hover.
  await window.locator('.repo-head__name').first().hover()
  await expect(tip).toHaveCount(0)
})

test('a session can be renamed, and the label follows', async ({ window }) => {
  await createSession(window, 'before rename')
  const row = window.locator('.session-row').first()

  /*
   * Read the branch rather than spelling it: it is a random handle, not a slug of the name. Asserting
   * it is *unchanged* is the real claim anyway — the old form hardcoded a derivation that no longer
   * exists and would have passed while testing nothing about renaming.
   */
  const branchOf = (): Promise<string> =>
    window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions[0]?.branch ?? ''))
  const before = await branchOf()
  expect(before).toMatch(/^feature\/[a-z]+-[a-z]+$/)

  await row.hover()
  await row.locator('[aria-label="Rename before rename"]').click()

  const dialog = window.locator('.modal')
  await expect(dialog).toBeVisible()
  // The branch is fixed at creation, so the dialog has to say the rename does not move it.
  await expect(dialog.locator('.modal__note')).toContainText(before)

  await window.fill('#rename-input', 'after rename')
  await window.click('.modal__actions .btn--primary')

  await expect(window.locator('.session-row__name').first()).toHaveText('after rename')
  // Renaming is a label change: the worktree it points at must not move.
  expect(await branchOf()).toBe(before)
})

test('a local session makes its own folder and is briefed like any other', async ({
  window,
  profileDir,
  agentLog
}) => {
  await window.click('[aria-label="New local session"]')
  // What you are working on is all it takes: making the folder is the default, so there is no path
  // to supply and no name to invent.
  await window.fill('#local-prompt', 'draft the release notes for 2.4')
  await window.click('.modal__actions .btn--primary')

  const row = window.locator('.repo-group--local .session-row__name')
  await expect(row).toHaveText('draft the release notes for 2.4', { timeout: 30_000 })

  // Not a worktree, and the session says so rather than borrowing the repo vocabulary.
  await expect(window.locator('.session__footer-path')).toContainText('folder ·')

  const session = await window.evaluate(() =>
    window.maestro
      .snapshot()
      .then((s) => s.sessions.find((x) => x.repoId === 'local'))
  )
  expect(session?.branch).toBe('')
  // Beside the worktrees Maestro cuts, under the same root, and named with the same kind of handle
  // — the typed text is a sentence now, and the path is the one name that cannot be corrected.
  expect(session?.worktreePath.startsWith(join(profileDir, 'worktrees', 'local') + '/')).toBe(true)
  expect(session?.worktreePath.split('/').pop()).toMatch(/^[a-z]+-[a-z]+$/)
  expect(existsSync(session!.worktreePath)).toBe(true)
  // Held open for Claude's title, exactly as a repo session is.
  expect(session?.awaitingTitle).toBe(true)

  // Maestro made the folder, so it is empty by construction: Claude starts on the work rather than
  // asking which conversation to pick up.
  await expect
    .poll(agentLog, { timeout: 20_000 })
    .toContain('ARGS: draft the release notes for 2.4')
})

test('a local session can work in a folder that already exists', async ({ window, profileDir }) => {
  await window.click('[aria-label="New local session"]')
  await window.click('.seg__opt:has-text("One I already have")')
  // The path is typed rather than picked: a native folder dialog is a modal the test cannot see
  // into, which is why the field exists alongside the picker.
  await window.fill('#local-path', profileDir)
  await window.fill('#local-name', 'in place')
  await window.click('.modal__actions .btn--primary')

  await expect(window.locator('.repo-group--local .session-row__name')).toHaveText('in place', {
    timeout: 30_000
  })
  await expect(window.locator('.session__meta-item')).toHaveText(profileDir)

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions.find((x) => x.name === 'in place'))
  )
  // Adopted in place: the directory is exactly the one given, not a copy under the maestro root.
  expect(session?.worktreePath).toBe(profileDir)
  /*
   * And never auto-titled. The title is read from the newest conversation in the directory, and a
   * directory that predates the session has conversations that are not this one — so the name given
   * here stands.
   */
  expect(session?.awaitingTitle).toBeUndefined()

  // A folder that predates the session may hold conversations, so it opens on the launcher; from
  // there Claude runs exactly as it does in a worktree.
  await window.click('.launcher .btn--primary')
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')
})

test('two local sessions can share a folder, and their agents are told about each other', async ({
  window,
  profileDir
}) => {
  const folder = join(profileDir, 'shared')
  await mkdir(folder, { recursive: true })
  const note = join(folder, '.claude', 'rules', 'maestro-shared-folder.md')

  const open = async (name: string): Promise<void> => {
    await window.click('[aria-label="New local session"]')
    await window.click('.seg__opt:has-text("One I already have")')
    await window.fill('#local-path', folder)
    await window.fill('#local-name', name)
  }

  await open('first')
  // One agent alone has nobody to mind.
  await expect(window.locator('.modal__note')).not.toContainText('second agent')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.modal')).toHaveCount(0, { timeout: 30_000 })
  expect(existsSync(note)).toBe(false)

  // The second is opened, not refused — and the dialog says who it will be sharing with.
  await open('second')
  await expect(window.locator('.modal__note')).toContainText('beside “first”')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.modal')).toHaveCount(0, { timeout: 30_000 })

  // Gathered under the folder they share, rather than as two unrelated rows.
  const group = window.locator('.repo-group--local .folder-group')
  await expect(group).toHaveCount(1)
  await expect(group.locator('.folder-head__name')).toHaveText('shared')
  await expect(group.locator('.session-row__name')).toHaveText(['first', 'second'])
  expect(await readFile(note, 'utf8')).toContain('Other agents are working in this folder')

  // Back to one agent, and the note goes with the need for it.
  const row = window.locator('.repo-group--local .session-row', { hasText: 'second' })
  await row.hover()
  await row.locator('[aria-label="Delete second"]').click()
  await window.locator('.modal .seg__opt:has-text("Delete")').click()
  // The folder is still another session's, so deleting it is not on offer.
  await expect(window.locator('.modal .launcher__empty')).toHaveCount(0, { timeout: 30_000 })
  await expect(window.locator('.modal .checkbox:has-text("Also delete the folder")')).toHaveCount(0)
  await expect(window.locator('.modal')).toContainText('“first” also works in it')
  await confirmDispose(window)
  await expect(window.locator('.modal')).toHaveCount(0)
  await expect.poll(() => existsSync(note)).toBe(false)
  // One session left is just a row again.
  await expect(group).toHaveCount(0)
  await expect(window.locator('.repo-group--local .session-row__name')).toHaveText(['first'])
})

test('deleting a local session keeps the folder unless asked to delete it', async ({ window }) => {
  await window.click('[aria-label="New local session"]')
  await window.fill('#local-prompt', 'keep my files')
  await window.click('.modal__actions .btn--primary')

  const row = window.locator('.repo-group--local .session-row').first()
  await expect(row).toBeVisible()
  const folder = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions.find((x) => x.repoId === 'local')!.worktreePath)
  )
  await row.hover()
  await row.locator('[aria-label="Delete keep my files"]').click()

  const dialog = window.locator('.modal')
  await expect(dialog.locator('.launcher__empty')).toHaveCount(0, { timeout: 30_000 })
  // Archiving never offers it.
  await dialog.locator('.seg__opt:has-text("Archive")').click()
  await expect(dialog.locator('.checkbox')).toHaveCount(0)

  await dialog.locator('.seg__opt:has-text("Delete")').click()
  await expect(dialog.locator('.outcome')).toContainText('kept')
  const box = dialog.locator('.checkbox:has-text("Also delete the folder")')
  await expect(box).toHaveCount(1)
  await box.click()
  await expect(dialog.locator('.outcome')).toContainText('deleted')
  await dialog.locator('.modal__actions .btn--primary').click()

  await expect(window.locator('.repo-group--local .session-row')).toHaveCount(0)
  expect(existsSync(folder)).toBe(false)
})

test('a local folder holding more than the session cannot be deleted', async ({
  window,
  profileDir
}) => {
  // The profile holds Maestro's own worktree root, so deleting it would take far more than this.
  await window.click('[aria-label="New local session"]')
  await window.click('.seg__opt:has-text("One I already have")')
  await window.fill('#local-path', profileDir)
  await window.fill('#local-name', 'too big to delete')
  await window.click('.modal__actions .btn--primary')

  const row = window.locator('.repo-group--local .session-row').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.hover()
  await row.locator('[aria-label="Delete too big to delete"]').click()

  const dialog = window.locator('.modal')
  await expect(dialog.locator('.launcher__empty')).toHaveCount(0, { timeout: 30_000 })
  await dialog.locator('.seg__opt:has-text("Delete")').click()
  await expect(dialog.locator('.checkbox')).toHaveCount(0)
  await expect(dialog).toContainText('Can’t delete the folder')

  // Main refuses too, whatever the renderer sends.
  const id = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions.find((x) => x.repoId === 'local')!.id)
  )
  const result = await window.evaluate(
    (sessionId) =>
      window.maestro.sessions.dispose(sessionId, {
        action: 'delete',
        wip: 'leave',
        deleteBranch: false,
        allowForeign: false,
        hardDelete: false,
        deleteFolder: true
      }),
    id
  )
  expect(result.ok).toBe(false)
  expect(existsSync(profileDir)).toBe(true)
})

test('a restored session picks up its conversation, not a new one', async ({
  window,
  agentLog
}) => {
  await createSession(window, 'archived and wanted back')
  // Wait for the agent to have actually run: the transcript it leaves behind is the thing
  // restoring has to find again.
  await expect.poll(agentLog, { timeout: 20_000 }).toContain('ARGS: archived and wanted back')

  const dialog = window.locator('.modal')
  const row = window.locator('.session-row').first()
  await row.hover()
  await row.locator('[aria-label="Archive archived and wanted back"]').click()
  await confirmDispose(window)
  await expect(dialog).toHaveCount(0)

  await window.locator('.archived-toggle').click()
  const archived = window.locator('.session-row.is-archived')
  await archived.locator('[aria-label="Restore archived and wanted back"]').click()

  /*
   * `--continue`, not a bare launch. Archiving and restoring inside one run leaves a session
   * younger than the app itself, and age was the only test — so bringing one back opened a brand
   * new conversation over the work the user had just asked to have back.
   */
  await expect.poll(agentLog, { timeout: 30_000 }).toContain('ARGS: --continue')
})

test('an archived session can be deleted, branch and all', async ({ window }) => {
  await createSession(window, 'archived leftovers')

  // Read before it is gone: the assertion at the end is about the branch archiving kept.
  const subject = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => {
      const session = s.sessions.find((x) => x.name === 'archived leftovers')
      return {
        branch: session?.branch ?? '',
        repoPath: s.repos.find((r) => r.id === session?.repoId)?.path ?? ''
      }
    })
  )
  expect(subject.branch).toBeTruthy()

  const dialog = window.locator('.modal')
  const row = window.locator('.session-row').first()
  await row.hover()
  await row.locator('[aria-label="Archive archived leftovers"]').click()
  await confirmDispose(window)
  await expect(dialog).toHaveCount(0)

  // The drawer was the only way back to it, and is now also the way to be rid of it.
  const toggle = window.locator('.archived-toggle')
  await expect(toggle).toHaveText(/1 archived/)
  await toggle.click()
  const archived = window.locator('.session-row.is-archived')
  await expect(archived).toHaveCount(1)
  await archived.locator('[aria-label="Delete archived leftovers"]').click()

  await expect(dialog).toBeVisible()
  // Nothing can be archived twice, so the action is stated rather than offered.
  await expect(dialog.locator('.seg--lg')).toHaveCount(0)
  // And the worktree is not threatened a second time — archiving already took it.
  await expect(dialog.locator('.outcome')).toContainText('already gone')

  // The branch is what archiving kept, so it is what this can still remove.
  await dialog.locator('.checkbox', { hasText: subject.branch }).click()
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0)

  // Gone from the sidebar, and gone from the repo: an archived session used to be undeletable
  // without restoring it first, which left its branch behind in every branch list.
  await expect(window.locator('.archived-toggle')).toHaveCount(0)
  const { stdout } = await exec('git', ['branch', '--list', subject.branch], {
    cwd: subject.repoPath
  })
  expect(stdout.trim()).toBe('')
})

test('archiving is offered per session and states what it will do', async ({ window }) => {
  await createSession(window, 'dispose test')
  const row = window.locator('.session-row').first()

  await row.hover()
  // By label, not position: the row's buttons have been reordered once already, and a positional
  // selector silently opened the wrong dialog rather than failing usefully.
  await row.locator('[aria-label="Archive dispose test"]').click()

  const dialog = window.locator('.modal')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.seg__opt.is-on')).toHaveText('Archive')
  // Maestro made this worktree and branch, so neither needs the foreign opt-in.
  await expect(dialog.locator('.outcome')).toContainText('deleted')
  await expect(dialog.locator('.checkbox--warn')).toHaveCount(0)
})

/** Opens the Remove dialog for a repo and waits for its plan. */
async function openRemoveRepo(window: Page, repo = 'demo-api'): Promise<void> {
  await window.hover(`.repo-group:has([aria-label="New session in ${repo}"]) .repo-head`)
  await window.click(`[aria-label="Remove ${repo}"]`)
  await expect(window.locator('.modal__title')).toHaveText(`Remove “${repo}”?`)
  await expect(window.locator('.modal .launcher__empty')).toHaveCount(0, { timeout: 30_000 })
}

const repoNames = (window: Page) =>
  window.locator('.repo-group:not(.repo-group--local) .repo-head__name')

test('removing a repo hides it and its sessions, and adding it back returns them', async ({
  window,
  relaunch,
  running
}) => {
  await createSession(window, 'work in a removed repo')
  const session = await window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions[0]))
  const repoPath = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.repos.find((r) => r.name === 'demo-api')!.path)
  )

  await openRemoveRepo(window)
  // Nothing is deleted unless asked.
  await expect(window.locator('.modal .outcome')).not.toContainText('deleted')
  await window.click('.modal__actions .btn--primary')

  await expect(repoNames(window)).toHaveText(['demo-web'])
  await expect(window.locator('.session-row')).toHaveCount(0)
  await expect(window.locator('.board__frame')).toHaveCount(0)
  expect(existsSync(session.worktreePath)).toBe(true)

  // Still hidden after a restart.
  const next = await relaunch()
  await expect(repoNames(next)).toHaveText(['demo-web'])
  await expect(next.locator('.session-row')).toHaveCount(0)

  // Add repo, with the native folder picker answered in main.
  await running.app!.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, repoPath)
  await next.click('.sidebar__foot .btn--block')

  // The same session, not a new one.
  await expect(repoNames(next)).toHaveText(['demo-web', 'demo-api'])
  await expect(next.locator('.session-row__name')).toHaveText(['work in a removed repo'])
  const ids = await next.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions.map((x) => x.id))
  )
  expect(ids).toEqual([session.id])
})

test('removing a repo can delete its worktrees and branches, settling uncommitted work first', async ({
  window
}) => {
  await createSession(window, 'throwaway work')
  const session = await window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions[0]))
  const repoPath = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.repos.find((r) => r.name === 'demo-api')!.path)
  )
  await writeFile(join(session.worktreePath, 'scratch.txt'), 'wip\n', 'utf8')

  await openRemoveRepo(window)
  const dialog = window.locator('.modal')
  // The branch box only appears once the worktrees are going.
  await expect(dialog.locator('.checkbox:has-text("Also delete their")')).toHaveCount(0)
  await dialog.locator('.checkbox:has-text("Also delete the 1 worktree")').click()
  await dialog.locator('.checkbox:has-text("Also delete their 1 branch")').click()
  await expect(dialog.locator('.outcome')).toContainText('1 deleted')

  // The uncommitted file must be dealt with before anything goes.
  const confirm = dialog.locator('.modal__actions .btn--primary')
  await expect(confirm).toBeDisabled()
  await dialog.locator('.seg__opt:has-text("Discard them")').click()
  await confirm.click()

  await expect(repoNames(window)).toHaveText(['demo-web'])
  expect(existsSync(session.worktreePath)).toBe(false)
  const { stdout } = await exec('git', ['-C', repoPath, 'branch', '--list', session.branch])
  expect(stdout.trim()).toBe('')

  // Nothing left to restore, so the record went with the branch.
  const result = await window.evaluate((path) => window.maestro.sessions.import(path), repoPath)
  expect(result.session).toBeDefined()
  await expect(window.locator('.session-row__name', { hasText: 'throwaway work' })).toHaveCount(0)
})

test('removing a repo can delete the repo folder, saying what is lost first', async ({
  window,
  profileDir
}) => {
  await createSession(window, 'goes with the repo')
  const session = await window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions[0]))
  const repoPath = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.repos.find((r) => r.name === 'demo-api')!.path)
  )
  await writeFile(join(session.worktreePath, 'scratch.txt'), 'wip\n', 'utf8')

  await openRemoveRepo(window)
  const dialog = window.locator('.modal')
  await dialog.locator('.checkbox:has-text("Delete the repo folder too")').click()
  await expect(dialog.locator('.modal__title')).toHaveText('Delete “demo-api”?')
  // No remote, so every commit is unpushed; and the uncommitted file is named as lost, not asked about.
  await expect(dialog.locator('.outcome')).toContainText('not on any remote')
  await expect(dialog.locator('.outcome')).toContainText('uncommitted file')
  await expect(dialog.locator('.seg__opt:has-text("Discard them")')).toHaveCount(0)
  await dialog.locator('.modal__actions .btn--primary').click()

  await expect(repoNames(window)).toHaveText(['demo-web'])
  expect(existsSync(repoPath)).toBe(false)
  expect(existsSync(session.worktreePath)).toBe(false)

  // Nothing left to come back, so the record is gone rather than hidden.
  await expect
    .poll(async () => {
      const store = JSON.parse(await readFile(join(profileDir, 'maestro.json'), 'utf8')) as {
        repos: { path: string }[]
        sessions: { id: string }[]
      }
      return {
        repo: store.repos.some((r) => r.path === repoPath),
        session: store.sessions.some((x) => x.id === session.id)
      }
    })
    .toEqual({ repo: false, session: false })
})

test('the repo folder is not offered for deletion while a worktree Maestro does not track uses it', async ({
  window,
  profileDir
}) => {
  const repoPath = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.repos.find((r) => r.name === 'demo-api')!.path)
  )
  const stray = join(profileDir, 'stray-worktree')
  await exec('git', ['-C', repoPath, 'worktree', 'add', '-b', 'stray', stray])

  await openRemoveRepo(window)
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.checkbox:has-text("Delete the repo folder too")')).toHaveCount(0)
  await expect(dialog).toContainText('Can’t delete the repo folder')

  // Main refuses too, whatever the renderer sends.
  const result = await window.evaluate(async () => {
    const id = (await window.maestro.snapshot()).repos.find((r) => r.name === 'demo-api')!.id
    return window.maestro.repos.remove(id, {
      removeWorktrees: false,
      deleteBranches: false,
      wip: 'leave',
      allowForeign: false,
      deleteFolder: true
    })
  })
  expect(result.ok).toBe(false)
  expect(existsSync(repoPath)).toBe(true)
})

/** Opens two local sessions in one new folder, so the sidebar groups them. */
async function openSharedFolder(window: Page, folder: string): Promise<void> {
  await mkdir(folder, { recursive: true })
  for (const name of ['first', 'second']) {
    await window.click('[aria-label="New local session"]')
    await window.click('.seg__opt:has-text("One I already have")')
    await window.fill('#local-path', folder)
    await window.fill('#local-name', name)
    await window.click('.modal__actions .btn--primary')
    await expect(window.locator('.modal')).toHaveCount(0, { timeout: 30_000 })
  }
  await expect(window.locator('.repo-group--local .folder-group')).toHaveCount(1)
}

test('a shared folder’s sessions can be deleted together, keeping the folder', async ({
  window,
  profileDir
}) => {
  const folder = join(profileDir, 'shared')
  await openSharedFolder(window, folder)

  await window.hover('.folder-head')
  await window.click('[aria-label="Delete sessions in shared"]')
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.launcher__empty')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialog.locator('.outcome')).toContainText('2 sessions')
  await expect(dialog.locator('.outcome')).toContainText('kept')
  await dialog.locator('.modal__actions .btn--primary').click()

  await expect(window.locator('.repo-group--local .session-row')).toHaveCount(0)
  expect(existsSync(folder)).toBe(true)
  // The note was only for while they shared it.
  expect(existsSync(join(folder, '.claude', 'rules', 'maestro-shared-folder.md'))).toBe(false)
})

test('a shared folder can be deleted with its sessions', async ({ window, profileDir }) => {
  const folder = join(profileDir, 'shared')
  await openSharedFolder(window, folder)

  await window.hover('.folder-head')
  await window.click('[aria-label="Delete sessions in shared"]')
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.launcher__empty')).toHaveCount(0, { timeout: 30_000 })
  await dialog.locator('.checkbox:has-text("Also delete the folder")').click()
  await expect(dialog.locator('.outcome')).toContainText('deleted')
  await dialog.locator('.modal__actions .btn--primary').click()

  await expect(window.locator('.repo-group--local .session-row')).toHaveCount(0)
  expect(existsSync(folder)).toBe(false)
})
