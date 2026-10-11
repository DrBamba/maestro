import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * The sidebar's repos, in the order the user put them in.
 *
 * The demo profile seeds two repos, so a drag of one onto the other is enough to show a reorder —
 * and a restart is what shows it was kept rather than just drawn.
 */

function repoNames(window: Page): Promise<string[]> {
  return window.locator('.repo-group:not(.repo-group--local) .repo-head__name').allTextContents()
}

/** The demo repos once they are listed, top to bottom. */
async function listed(window: Page): Promise<string[]> {
  await expect.poll(async () => (await repoNames(window)).length).toBeGreaterThanOrEqual(2)
  return repoNames(window)
}

function head(window: Page, repo: string): Locator {
  return window.locator('.repo-head', { has: window.locator(`[aria-label="Remove ${repo}"]`) })
}

test('a repo dragged by its heading moves, and stays moved', async ({ window, relaunch }) => {
  const before = await listed(window)
  const [first, second] = before

  // Onto the bottom half of the second group: below it.
  const target = window.locator('.repo-group', {
    has: window.locator(`[aria-label="Remove ${second}"]`)
  })
  const box = (await target.boundingBox())!
  await head(window, first).dragTo(target, {
    targetPosition: { x: box.width / 2, y: box.height - 2 }
  })

  const after = [second, first, ...before.slice(2)]
  await expect.poll(() => repoNames(window)).toEqual(after)

  const next = await relaunch()
  await expect.poll(() => repoNames(next)).toEqual(after)
})

test('a repo dropped on Local becomes the first repo, under it', async ({ window }) => {
  const before = await listed(window)
  const last = before[before.length - 1]

  await head(window, last).dragTo(window.locator('.repo-group--local .repo-head'))

  await expect.poll(() => repoNames(window)).toEqual([last, ...before.slice(0, -1)])
  // Local still heads the list.
  await expect(window.locator('.sidebar__scroll > .repo-group').first()).toHaveClass(/repo-group--local/)
})

test('a repo dropped in the space under the list becomes the last', async ({ window }) => {
  const before = await listed(window)
  const scroll = window.locator('.sidebar__scroll')
  const box = (await scroll.boundingBox())!

  await head(window, before[0]).dragTo(scroll, {
    targetPosition: { x: box.width / 2, y: box.height - 4 }
  })

  await expect.poll(() => repoNames(window)).toEqual([...before.slice(1), before[0]])
})
