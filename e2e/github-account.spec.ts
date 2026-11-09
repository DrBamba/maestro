import type { Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * A repo's GitHub account, picked from the accounts `gh` is logged into. A stand-in `gh` answers
 * for two accounts and hands out a token named after each, so what reaches git and the agent can be
 * read back without a real login.
 */
const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "auth status")
    printf '%s' '{"hosts":{"github.com":[{"login":"home-acct","active":true,"state":"success"},{"login":"work-acct","active":false,"state":"success"}]}}' ;;
  "auth token")
    while [ $# -gt 0 ]; do [ "$1" = --user ] && { echo "token-$2"; exit 0; }; shift; done
    exit 1 ;;
  "api repos/"*)
    # Who may push where: both accounts on the shared repos, only work-acct on solo.
    case "$2:$GH_TOKEN" in
      repos/some-org/shared:*|repos/home-acct/mine:*|repos/some-org/solo:token-work-acct) echo true ;;
      *) echo false ;;
    esac ;;
  *) exit 1 ;;
esac
`

test.use({ stubs: { gh: GH_STUB } })

async function createSession(window: Page, name: string, repo: string): Promise<void> {
  await window.click(`[aria-label="New session in ${repo}"]`)
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name', { hasText: name })).toHaveCount(1, { timeout: 30_000 })
}

async function openAccountDialog(window: Page): Promise<void> {
  await window.keyboard.press('ControlOrMeta+k')
  await window.fill('.palette__input', 'GitHub account')
  await window.keyboard.press('Enter')
  await expect(window.locator('.modal__title')).toHaveText('GitHub account')
}

async function config(cwd: string, key: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['config', '--local', '--get', key], { cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

test('a repo pushes and starts agents as the account picked for it', async ({ window, profileDir }) => {
  const repo = join(profileDir, 'demo-repos', 'demo-api')
  const stubPath = `${join(profileDir, 'stub-bin')}:${process.env.PATH ?? ''}`
  const tokens = async (): Promise<string> => {
    try {
      return await readFile(join(profileDir, 'agent-input.log.env'), 'utf8')
    } catch {
      return ''
    }
  }

  await createSession(window, 'before', 'demo-api')
  // Nothing picked yet: gh's own active account decides, so no token is handed out.
  expect(await tokens()).toBe('')

  await openAccountDialog(window)
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.seg__opt')).toHaveText(['gh default', 'home-acct', 'work-acct'])
  await expect(dialog.locator('.seg__opt.is-on')).toHaveText('gh default')
  await dialog.locator('.seg__opt', { hasText: 'work-acct' }).click()
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0)

  expect(await config(repo, 'maestro.githubAccount')).toBe('work-acct')

  // git itself asks for credentials as that account, from any worktree of the repo.
  const worktree = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions.find((x) => x.name === 'before')!.worktreePath)
  )
  const filled = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      ['credential', 'fill'],
      { cwd: worktree, env: { ...process.env, PATH: stubPath, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
    child.stdin!.end('protocol=https\nhost=github.com\n\n')
  })
  expect(filled).toContain('username=work-acct')
  expect(filled).toContain('password=token-work-acct')

  // An agent started now carries the account's token for gh.
  await createSession(window, 'after', 'demo-api')
  await expect.poll(tokens, { timeout: 15_000 }).toContain('GH_TOKEN=token-work-acct')

  // Going back to gh's default clears both the setting and the helper.
  await openAccountDialog(window)
  await expect(dialog.locator('.seg__opt.is-on')).toHaveText('work-acct')
  await dialog.locator('.seg__opt', { hasText: 'gh default' }).click()
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0)
  expect(await config(repo, 'maestro.githubAccount')).toBe('')
  expect(await config(repo, 'credential.https://github.com.helper')).toBe('')
})

/** A repo cloned outside Maestro, with `origin` on GitHub, added through Add repo's folder picker. */
async function addRepoFrom(
  window: Page,
  app: import('@playwright/test').ElectronApplication,
  dir: string,
  origin: string
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: dir
  })
  await exec('git', ['remote', 'add', 'origin', origin], { cwd: dir })
  // The native picker cannot be driven, so it answers with the folder.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, dir)
  await window.click('.sidebar__foot .btn--block')
}

test('adding a repo picks the one account that can push, or the owner of several', async ({
  window,
  app,
  profileDir
}) => {
  const solo = join(profileDir, 'outside', 'solo')
  await addRepoFrom(window, app, solo, 'https://github.com/some-org/solo.git')
  await expect(window.locator('.toast', { hasText: 'Added solo as work-acct' })).toHaveCount(1)
  expect(await config(solo, 'maestro.githubAccount')).toBe('work-acct')

  const mine = join(profileDir, 'outside', 'mine')
  await addRepoFrom(window, app, mine, 'git@github.com:home-acct/mine.git')
  await expect(window.locator('.toast', { hasText: 'Added mine as home-acct' })).toHaveCount(1)
  expect(await config(mine, 'maestro.githubAccount')).toBe('home-acct')
})

test('adding a repo several accounts can push to, owned by neither, asks which', async ({
  window,
  app,
  profileDir
}) => {
  const shared = join(profileDir, 'outside', 'shared')
  await addRepoFrom(window, app, shared, 'https://github.com/some-org/shared.git')
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.modal__title')).toHaveText('GitHub account')
  await expect(dialog.locator('.modal__note')).toContainText('More than one of your accounts can push here')
  await expect(dialog.locator('.seg__opt')).toHaveText(['gh default', 'home-acct', 'work-acct'])
  await dialog.locator('.seg__opt', { hasText: 'work-acct' }).click()
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0)
  expect(await config(shared, 'maestro.githubAccount')).toBe('work-acct')
})

test('a repo cloned in Maestro keeps the account it was cloned as', async ({ window, profileDir }) => {
  const source = join(profileDir, 'demo-repos', 'demo-web')
  const parent = join(profileDir, 'clones')

  await window.keyboard.press('ControlOrMeta+k')
  await window.fill('.palette__input', 'Clone repo')
  await window.keyboard.press('Enter')
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.modal__title')).toHaveText('Clone repo')
  await window.fill('#clone-source', source)
  await window.fill('#clone-parent', parent)
  await expect(dialog.locator('.seg__opt.is-on')).toHaveText('home-acct')
  await dialog.locator('.seg__opt', { hasText: 'work-acct' }).click()
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })

  const clone = join(parent, 'demo-web')
  expect(await config(clone, 'maestro.githubAccount')).toBe('work-acct')
  expect(await config(clone, 'remote.origin.url')).toBe(source)
  const paths = await window.evaluate(() => window.maestro.snapshot().then((s) => s.repos.map((r) => r.path)))
  expect(paths.some((p) => p.endsWith('/clones/demo-web'))).toBe(true)
})

test('a repo added before accounts were guessed gets one at its next session', async ({ window, profileDir }) => {
  const repo = join(profileDir, 'demo-repos', 'demo-api')
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/some-org/solo.git'], { cwd: repo })
  await createSession(window, 'guessed', 'demo-api')
  expect(await config(repo, 'maestro.githubAccount')).toBe('work-acct')
  await expect
    .poll(() => readFile(join(profileDir, 'agent-input.log.env'), 'utf8').catch(() => ''), { timeout: 15_000 })
    .toContain('GH_TOKEN=token-work-acct')
})
