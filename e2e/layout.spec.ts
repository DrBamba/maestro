import type { Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'

/**
 * Arranging a session's panes.
 *
 * The claim every one of these rests on is that rearranging is a change of geometry and nothing
 * else: a pane holds a live process or a whole embedded editor, so a tab that moves must not take
 * its pane down and up again. That is asserted through the agent's own log — a Claude that was
 * restarted writes a second banner — rather than through anything on screen.
 */

async function createSession(window: Page, name: string, repo = 'demo-api'): Promise<void> {
  await window.click(`[aria-label="New session in ${repo}"]`)
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText(name, { timeout: 30_000 })
}

/** The class of whatever currently holds keyboard focus. */
/**
 * Which tab's pane the keyboard is in. Every xterm's focus target is an identical textarea, so "a
 * terminal has focus" also passes while the keyboard is still in the pane the drag left.
 */
function focusedPane(window: Page): Promise<string | null> {
  return window.evaluate(
    () => document.activeElement?.closest('[data-pane-key]')?.getAttribute('data-pane-key') ?? null
  )
}

function tab(window: Page, key: string) {
  return window.locator(`.tab[data-tab-key="${key}"]`)
}

/** Drags a tab to a point, in the several steps a real drag takes. */
async function dragTab(window: Page, key: string, to: { x: number; y: number }): Promise<void> {
  const box = (await tab(window, key).boundingBox())!
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(to.x, to.y, { steps: 12 })
  await window.mouse.up()
}

/** A point just inside the named edge of a frame, which is where a drop splits it. */
async function edgeOf(
  window: Page,
  index: number,
  side: 'left' | 'right' | 'top' | 'bottom'
): Promise<{ x: number; y: number }> {
  const box = (await window.locator('.board__frame').nth(index).boundingBox())!
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  if (side === 'left') return { x: box.x + 8, y: middle.y }
  if (side === 'right') return { x: box.x + box.width - 8, y: middle.y }
  if (side === 'top') return { x: middle.x, y: box.y + 40 }
  return { x: middle.x, y: box.y + box.height - 8 }
}

async function stripOf(window: Page, index: number): Promise<{ x: number; y: number }> {
  const box = (await window.locator('.board__strip').nth(index).boundingBox())!
  return { x: box.x + box.width - 20, y: box.y + box.height / 2 }
}

test('a session opens as one pane holding every tab', async ({ window }) => {
  await createSession(window, 'one pane')
  await expect(window.locator('.board__frame')).toHaveCount(1)
  await expect(window.locator('.board__gutter')).toHaveCount(0)
  // Nothing to put back yet, so the way back is not on screen.
  await expect(window.locator('[aria-label="Restore default layout"]')).toHaveCount(0)
})

test('the terminal’s last row is never clipped, whatever the window height', async ({
  window,
  app
}) => {
  await createSession(window, 'every height')
  // A row is about 16px, so a sweep in 3px steps lands on every remainder at least once.
  for (let height = 700; height <= 760; height += 3) {
    const before = await window.evaluate(() => window.innerHeight)
    await app.evaluate(({ BrowserWindow }, h) => {
      BrowserWindow.getAllWindows()[0].setSize(1200, h)
    }, height)
    await window.waitForFunction((was) => window.innerHeight !== was, before)
    await expect
      .poll(() =>
        window.evaluate(
          () =>
            new Promise<number | null>((resolve) =>
              // Two frames for the ResizeObserver's fit to land.
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const term = [...document.querySelectorAll<HTMLElement>('.term')].find(
                    (t) => t.offsetParent !== null
                  )
                  const screen = term?.querySelector<HTMLElement>('.xterm-screen')
                  if (!term || !screen) return resolve(null)
                  const content =
                    term.getBoundingClientRect().bottom -
                    parseFloat(getComputedStyle(term).paddingBottom)
                  resolve(Math.round(screen.getBoundingClientRect().bottom - content))
                })
              )
            )
        )
      )
      .toBeLessThanOrEqual(0)
  }
})

test('a tab dragged to a pane’s edge splits the session in two', async ({ window }) => {
  await createSession(window, 'split it')
  const frames = window.locator('.board__frame')

  await dragTab(window, 'console-1', await edgeOf(window, 0, 'right'))
  await expect(frames).toHaveCount(2)

  // Side by side, sharing a top edge: halves, not one pane over the other.
  const left = (await frames.nth(0).boundingBox())!
  const right = (await frames.nth(1).boundingBox())!
  expect(right.x).toBeGreaterThan(left.x + left.width - 1)
  expect(Math.round(right.y)).toBe(Math.round(left.y))

  // Two panes, so two tabs are on screen at once — which is the whole point of the exercise.
  await expect(window.locator('.tab.is-on')).toHaveCount(2)
  await expect(tab(window, 'claude')).toHaveClass(/is-on/)
  await expect(tab(window, 'console-1')).toHaveClass(/is-on/)

  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )

  /*
   * A console starts its shell when its tab first reaches the screen. It was dragged there rather
   * than clicked, and starting only on a click would have left this pane empty — so the assertion
   * is a shell that runs, through the filesystem, since its output only reaches a WebGL canvas.
   */
  await expect.poll(() => focusedPane(window), { timeout: 15_000 }).toBe('console-1')
  await window.keyboard.type('echo dragged > dragged.txt')
  await window.keyboard.press('Enter')
  await expect
    .poll(() => existsSync(join(session.worktreePath, 'dragged.txt')), { timeout: 20_000 })
    .toBe(true)
})

test('the pane that moves keeps the process it was running', async ({ window, agentLog }) => {
  await createSession(window, 'keep the agent')
  const banners = async (): Promise<number> => (await agentLog()).split('ARGS:').length - 1
  await expect.poll(banners, { timeout: 20_000 }).toBe(1)

  await dragTab(window, 'claude', await edgeOf(window, 0, 'bottom'))
  await expect(window.locator('.board__frame')).toHaveCount(2)

  /*
   * One banner still. A pane is positioned rather than reparented, so moving Claude must not take
   * its terminal down and up again — a restart would print a second `ARGS:` line and lose the
   * conversation with it.
   */
  await expect.poll(() => focusedPane(window), { timeout: 15_000 }).toBe('claude')
  await window.keyboard.type('still the same claude')
  await window.keyboard.press('Enter')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('still the same claude')
  expect(await banners()).toBe(1)
})

test('the edge between two panes drags to resize them', async ({ window }) => {
  await createSession(window, 'resize it')
  await dragTab(window, 'console-1', await edgeOf(window, 0, 'right'))

  const gutter = window.locator('.board__gutter')
  await expect(gutter).toHaveCount(1)
  await expect(gutter).toHaveAttribute('aria-orientation', 'vertical')

  const before = (await window.locator('.board__frame').first().boundingBox())!
  const grip = (await gutter.boundingBox())!
  await window.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await window.mouse.down()
  await window.mouse.move(grip.x + grip.width / 2 - 120, grip.y + grip.height / 2, { steps: 10 })
  await window.mouse.up()

  // The gutter follows the pointer exactly: 120px off the left pane, not a step of its own choosing.
  const after = (await window.locator('.board__frame').first().boundingBox())!
  expect(Math.abs(after.width - (before.width - 120))).toBeLessThan(3)

  // And the pane on screen is resized with its frame, not left at its old size.
  const pane = (await window.locator('.board__pane').first().boundingBox())!
  expect(Math.abs(pane.width - after.width)).toBeLessThan(4)
})

test('panes can be arranged into quarters', async ({ window }) => {
  await createSession(window, 'quarters')
  await window.click('[aria-label="New console"]')
  const frames = window.locator('.board__frame')

  // One split at a time: the next drop is aimed at a frame the last one produced.
  await dragTab(window, 'console-1', await edgeOf(window, 0, 'right'))
  await expect(frames).toHaveCount(2)
  await dragTab(window, 'editor', await edgeOf(window, 0, 'bottom'))
  await expect(frames).toHaveCount(3)
  await dragTab(window, 'console-2', await edgeOf(window, 2, 'bottom'))
  await expect(frames).toHaveCount(4)
  // Two columns and two rows, which is what a quarter layout is.
  const corners = await frames.evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect()
      return { x: Math.round(rect.x), y: Math.round(rect.y) }
    })
  )
  expect(new Set(corners.map((corner) => corner.x)).size).toBe(2)
  expect(new Set(corners.map((corner) => corner.y)).size).toBe(2)
  // One edge between the columns, and one inside each of them.
  await expect(window.locator('.board__gutter')).toHaveCount(3)
})

test('a tab dropped on another pane’s strip joins it, and an emptied pane closes', async ({
  window
}) => {
  await createSession(window, 'join up')
  const frames = window.locator('.board__frame')
  await dragTab(window, 'console-1', await edgeOf(window, 0, 'right'))
  await expect(frames).toHaveCount(2)

  // Onto the strip, not the pane: no new pane, the tab simply lands in that row.
  await dragTab(window, 'claude', await stripOf(window, 1))
  await expect(frames).toHaveCount(2)
  await expect(window.locator('.board__strip').nth(1).locator('.tab[data-tab-key]')).toHaveCount(2)

  // The pane the last tab left has nothing to show, so it goes rather than sitting there blank.
  await dragTab(window, 'editor', await stripOf(window, 1))
  await expect(frames).toHaveCount(1)
  await expect(window.locator('.tab[data-tab-key]')).toHaveCount(3)
})

test('restoring the default layout puts every tab back in one pane', async ({ window }) => {
  await createSession(window, 'put it back')
  await window.click('[aria-label="New console"]')
  await dragTab(window, 'console-1', await edgeOf(window, 0, 'right'))
  await expect(window.locator('.board__frame')).toHaveCount(2)
  await dragTab(window, 'editor', await edgeOf(window, 0, 'bottom'))
  await expect(window.locator('.board__frame')).toHaveCount(3)

  const restore = window.locator('[aria-label="Restore default layout"]')
  await expect(restore).toBeVisible()
  await restore.click()

  await expect(window.locator('.board__frame')).toHaveCount(1)
  await expect(window.locator('.board__gutter')).toHaveCount(0)
  // Claude, Editor and both consoles, back in the order the session opened with.
  const keys = await window
    .locator('.board__strip .tab[data-tab-key]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tabKey))
  expect(keys).toEqual(['claude', 'editor', 'console-1', 'console-2'])
  // And the button that did it is gone, because there is nothing left to put back.
  await expect(restore).toHaveCount(0)
})

test('an arrangement survives quitting the app', async ({ window, relaunch }) => {
  await createSession(window, 'kept layout')
  await dragTab(window, 'editor', await edgeOf(window, 0, 'right'))
  await expect(window.locator('.board__frame')).toHaveCount(2)
  // The store writes on a short debounce; quitting flushes it either way.
  const next = await relaunch()

  const frames = next.locator('.board__frame')
  await expect(frames).toHaveCount(2, { timeout: 20_000 })
  await expect(frames.nth(1).locator('.tab[data-tab-key="editor"]')).toHaveCount(1)
  await expect(frames.nth(0).locator('.tab[data-tab-key="claude"]')).toHaveCount(1)
})
