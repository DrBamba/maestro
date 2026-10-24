import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * Maestro can be replaced while it runs — the window reloaded, or the whole app relaunched onto a
 * newer build — without touching the agents working inside it. These prove that from the agent's
 * side: the stub logs one `ARGS:` line per process it starts, so a count of one after the swap
 * means the same Claude carried on, and what is typed afterwards shows it is still connected.
 */

async function createSession(window: Page, name: string, repo = 'demo-api'): Promise<void> {
  await window.click(`[aria-label="New session in ${repo}"]`)
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText(name, { timeout: 30_000 })
}

function activeClass(window: Page): Promise<string> {
  return window.evaluate(() => document.activeElement?.className ?? '')
}

function starts(log: string): number {
  return log.split('\n').filter((line) => line.startsWith('ARGS:')).length
}

async function typeToClaude(window: Page, text: string): Promise<void> {
  await window.click('.tab:has-text("Claude")')
  // The tab button keeps focus after the click; the terminal takes it when clicked into.
  await window.locator('.session:visible .term:visible').first().click()
  await expect.poll(() => activeClass(window), { timeout: 15_000 }).toContain('xterm-helper-textarea')
  await window.keyboard.type(text)
  await window.keyboard.press('Enter')
}

test('reloading the window keeps Claude running and reconnects to it', async ({
  window,
  agentLog
}) => {
  await createSession(window, 'survives reload')
  await typeToClaude(window, 'before the reload')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('before the reload')

  await window.reload()
  await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })

  await typeToClaude(window, 'after the reload')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('after the reload')
  expect(starts(await agentLog())).toBe(1)
})

test('replacing the app keeps Claude running, and its consoles and panes', async ({
  window,
  agentLog,
  relaunch
}) => {
  await createSession(window, 'survives relaunch')
  await typeToClaude(window, 'before the relaunch')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('before the relaunch')

  // A renamed second console, so there is something beyond the defaults to put back.
  await window.click('.tab:has-text("Console")')
  await window.click('[aria-label="New console"]')
  await expect(window.locator('.tab:has-text("Console 2")')).toHaveCount(1)
  await window.locator('.tab:has-text("Console 2")').dblclick()
  await window.fill('.tab__rename', 'server')
  await window.keyboard.press('Enter')
  await expect(window.locator('.tab:has-text("server")')).toHaveCount(1)
  // A kill gives the window no chance to save on the way out, so wait for the rename to be kept.
  await expect
    .poll(() => window.evaluate(() => window.maestro.snapshot().then((s) => JSON.stringify(s.windowState))))
    .toContain('"label":"server"')

  const next = await relaunch(undefined, 'kill')

  await expect(next.locator('.tab:has-text("server")')).toHaveCount(1, { timeout: 15_000 })
  // No launcher asking how to start: the Claude that was running is simply shown again.
  await expect(next.locator('.launcher')).toHaveCount(0)
  await typeToClaude(next, 'after the relaunch')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('after the relaunch')
  expect(starts(await agentLog())).toBe(1)
})

test('quitting still ends Claude', async ({ window, agentLog, relaunch }) => {
  await createSession(window, 'quit ends it')
  await typeToClaude(window, 'before quitting')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('before quitting')

  const next = await relaunch()
  await next.click('.session-row:has-text("quit ends it")')
  // A fresh start of the same conversation — a second process, not the first one reattached.
  await expect.poll(async () => starts(await agentLog()), { timeout: 15_000 }).toBe(2)
})

test('reloading with many sessions open keeps the shown terminal drawn', async ({ window }) => {
  test.setTimeout(180_000)
  // More terminals than Chromium keeps WebGL contexts for, which is about sixteen.
  for (let i = 0; i < 10; i++) {
    await window.click('[aria-label="New session in demo-api"]')
    await window.fill('#session-name', `busy ${i}`)
    await window.click('.modal__actions .btn--primary')
    await expect(window.locator(`.session-row__name:text-is("busy ${i}")`)).toHaveCount(1, { timeout: 30_000 })
    await window.click('.session:visible .tab:has-text("Console")')
    await window.click('.session:visible .tab:has-text("Claude")')
  }
  await window.click('.session-row:has-text("busy 3")')

  const lost: string[] = []
  window.on('console', (message) => {
    if (/Too many active WebGL contexts|webglcontextlost/.test(message.text())) lost.push(message.text())
  })
  await window.reload()
  await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
  await expect(window.locator('.session:visible .term:visible')).toHaveCount(1, { timeout: 15_000 })
  // Long enough for a dropped context to be reported, which xterm waits three seconds to do.
  await window.waitForTimeout(4000)

  expect(lost).toEqual([])
  // Only what is on screen holds a context.
  expect(await window.locator('.xterm canvas').count()).toBeLessThanOrEqual(4)
})
