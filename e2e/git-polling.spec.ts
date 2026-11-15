import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * The active session's git status is polled every four seconds, not back to back.
 *
 * It was once restarted by every render of the app, and every result rendered the app again, so
 * git ran in a tight loop for as long as a session was open: dozens of processes a second, enough
 * to make terminals stutter. The stand-in `git` writes down each call and hands it to the real one.
 * `ls-files --others` runs once per status pass and nowhere else, so it counts the passes.
 */

const GIT_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$MAESTRO_E2E_LOG.git"
exec /usr/bin/git "$@"
`

test.use({ stubs: { git: GIT_STUB } })

async function statusPasses(profileDir: string): Promise<number> {
  const log = await readFile(join(profileDir, 'agent-input.log.git'), 'utf8').catch(() => '')
  return log.split('\n').filter((line) => line.startsWith('ls-files --others')).length
}

async function createSession(window: Page, name: string, repo: string): Promise<void> {
  await window.click(`[aria-label="New session in ${repo}"]`)
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name', { hasText: name })).toHaveCount(1, { timeout: 30_000 })
}

test('an open session polls git status on an interval, not in a loop', async ({ window, profileDir }) => {
  await createSession(window, 'polled', 'demo-api')
  await expect.poll(() => statusPasses(profileDir), { timeout: 15_000 }).toBeGreaterThan(0)

  const before = await statusPasses(profileDir)
  await window.waitForTimeout(9_000)
  // Two or three ticks of a four-second poll, with room for a focus or arrangement refresh.
  expect((await statusPasses(profileDir)) - before).toBeLessThanOrEqual(5)
})

test('polling pauses while Maestro is in the background, and catches up on return', async ({
  window,
  profileDir
}) => {
  await createSession(window, 'background', 'demo-api')
  await expect.poll(() => statusPasses(profileDir), { timeout: 15_000 }).toBeGreaterThan(0)

  // A headless test window always reports focus, so the page is told it has none.
  await window.evaluate(() => {
    document.hasFocus = () => false
  })
  await window.waitForTimeout(500) // a pass already under way still lands
  const away = await statusPasses(profileDir)
  await window.waitForTimeout(9_000)
  expect(await statusPasses(profileDir)).toBe(away)

  await window.evaluate(() => {
    document.hasFocus = () => true
    window.dispatchEvent(new Event('focus'))
  })
  await expect.poll(() => statusPasses(profileDir), { timeout: 5_000 }).toBeGreaterThan(away)
})
