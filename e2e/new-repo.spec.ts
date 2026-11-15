import type { Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * Starting a repo from the Add repo dialog. The stand-in `gh` starts with no accounts; `auth login`
 * prints a one-time code the way gh does without a terminal, then stores `new-acct` by creating a
 * marker beside the agent log. `repo create` makes a bare repo in the profile and wires it up as
 * `origin`, so the push can be checked without GitHub.
 */
const GH_STUB = `#!/bin/sh
accounts="$MAESTRO_E2E_LOG.gh-accounts"
case "$1 $2" in
  "auth status")
    # Like gh: a token in the environment is listed as one more account, and the active one.
    if [ -n "$GH_TOKEN" ] && [ -f "$accounts" ]; then
      printf '%s' '{"hosts":{"github.com":[{"login":"new-acct","active":true,"state":"success","tokenSource":"GH_TOKEN"},{"login":"new-acct","active":false,"state":"success"}]}}'
    elif [ -f "$accounts" ]; then
      printf '%s' '{"hosts":{"github.com":[{"login":"new-acct","active":true,"state":"success"}]}}'
    else
      printf '%s' '{"hosts":{}}'
    fi ;;
  "auth login")
    [ -n "$GH_TOKEN" ] && { echo "GH_TOKEN is set" >&2; exit 1; }
    printf '\\n! First copy your one-time code: AB12-CD34\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n' >&2
    sleep 2
    touch "$accounts" ;;
  "auth token")
    [ -f "$accounts" ] && { echo token-new-acct; exit 0; }
    exit 1 ;;
  "api user")
    [ "$GH_TOKEN" = token-new-acct ] && { echo '{"id":333,"login":"new-acct","name":"New Person"}'; exit 0; }
    exit 1 ;;
  "repo create")
    printf '%s\\n' "$*" >> "$MAESTRO_E2E_LOG.gh-create"
    name="$3"; shift 3; push=""; src=""
    while [ $# -gt 0 ]; do
      case "$1" in --source) src="$2"; shift ;; --push) push=1 ;; esac
      shift
    done
    bare="$(dirname "$MAESTRO_E2E_LOG")/remotes/$name.git"
    mkdir -p "$bare" && git init -q --bare "$bare"
    git -C "$src" remote add origin "$bare"
    [ -n "$push" ] && git -C "$src" push -q -u origin HEAD ;;
  *) exit 1 ;;
esac
`

test.use({ stubs: { gh: GH_STUB } })

async function config(cwd: string, key: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['config', '--local', '--get', key], { cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

async function openNew(window: Page): Promise<void> {
  await window.click('.sidebar__foot .btn--block')
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.modal__title')).toHaveText('Add repo')
  await dialog.locator('[aria-label="How to add it"] .seg__opt', { hasText: 'New' }).click()
}

test('a new repo connects an account, starts with the files picked, and lands on GitHub', async ({
  window,
  profileDir
}) => {
  const dir = join(profileDir, 'made', 'fresh-app')
  await openNew(window)
  const dialog = window.locator('.modal')

  // No account yet: the field offers to connect one and shows gh's code while it waits.
  await expect(dialog.locator('[aria-label="On GitHub"] .seg__opt', { hasText: 'Private' })).toBeDisabled()
  await dialog.locator('.btn', { hasText: 'Connect GitHub' }).click()
  await expect(dialog.locator('[aria-label="One-time code"]')).toHaveText('AB12-CD34')
  await expect(dialog.locator('[aria-label="GitHub account"] .seg__opt.is-on')).toHaveText('new-acct', {
    timeout: 15_000
  })

  await window.fill('#new-path', dir)
  await dialog.locator('.checkbox', { hasText: 'MIT license' }).click()
  await dialog.locator('#new-gitignore').selectOption('Node')
  await window.fill('#new-branch', 'trunk')
  await dialog.locator('.seg__opt', { hasText: 'Private' }).click()
  await expect(dialog.locator('.field__hint', { hasText: 'Creates new-acct/fresh-app and pushes' })).toHaveCount(1)
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(window.locator('.toast', { hasText: 'Created fresh-app as new-acct' })).toHaveCount(1)

  expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# fresh-app\n')
  expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('node_modules/')
  expect(await readFile(join(dir, 'LICENSE'), 'utf8')).toContain('Copyright (c) ')
  expect(await readFile(join(dir, 'LICENSE'), 'utf8')).toContain('New Person')

  // Committed as the account, on the branch asked for.
  expect(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk')
  expect(await git(dir, 'log', '--format=%an <%ae>|%s')).toBe(
    'New Person <333+new-acct@users.noreply.github.com>|Initial commit'
  )
  expect(await git(dir, 'ls-files')).toBe('.gitignore\nLICENSE\nREADME.md')
  expect(await config(dir, 'maestro.githubAccount')).toBe('new-acct')

  // Created private on GitHub, and the commit pushed there.
  expect(await readFile(join(profileDir, 'agent-input.log.gh-create'), 'utf8')).toContain('--private')
  const bare = join(profileDir, 'remotes', 'fresh-app.git')
  expect(await config(dir, 'remote.origin.url')).toBe(bare)
  expect(await git(bare, 'rev-parse', 'trunk')).toBe(await git(dir, 'rev-parse', 'HEAD'))

  const repos = await window.evaluate(() => window.maestro.snapshot().then((s) => s.repos))
  const added = repos.find((r) => r.path.endsWith('/made/fresh-app'))
  expect(added?.defaultBranch).toBe('trunk')
})

test('a new repo in a folder with work keeps its files, and refuses one that is already a repo', async ({
  window,
  profileDir
}) => {
  await writeFile(join(profileDir, 'agent-input.log.gh-accounts'), '')
  const dir = join(profileDir, 'made', 'has-work')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'README.md'), 'mine\n')
  await writeFile(join(dir, 'main.py'), 'print(1)\n')

  await openNew(window)
  const dialog = window.locator('.modal')
  await expect(dialog.locator('[aria-label="GitHub account"] .seg__opt.is-on')).toHaveText('new-acct')
  await window.fill('#new-path', dir)
  await dialog.locator('#new-gitignore').selectOption('Python')
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })

  // The README it had wins over the starter one; everything is in the first commit; no remote.
  expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('mine\n')
  expect(await git(dir, 'ls-files')).toBe('.gitignore\nREADME.md\nmain.py')
  expect(await config(dir, 'remote.origin.url')).toBe('')
  expect(existsSync(join(profileDir, 'agent-input.log.gh-create'))).toBe(false)

  // Now it is a repo, so starting one there again is refused and nothing changes.
  await openNew(window)
  await window.fill('#new-path', dir)
  await dialog.locator('.modal__actions .btn--primary').click()
  await expect(dialog.locator('.modal__error')).toContainText('is already a git repository')
})

test.describe('started from a Maestro terminal', () => {
  test.use({ appEnv: { GH_TOKEN: 'token-new-acct' } })

  test('an inherited GH_TOKEN does not list an account twice', async ({ window, profileDir }) => {
    await writeFile(join(profileDir, 'agent-input.log.gh-accounts'), '')
    await openNew(window)
    await expect(window.locator('.modal [aria-label="GitHub account"] .seg__opt')).toHaveText(['new-acct'])
  })
})
