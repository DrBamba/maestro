import type { Page } from '@playwright/test'
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

test('a repo dragged by its heading moves, and stays moved', async ({ window, relaunch }) => {
  await expect(window.locator('.repo-group:not(.repo-group--local)')).not.toHaveCount(0)
  await expect.poll(async () => (await repoNames(window)).length).toBeGreaterThanOrEqual(2)
  const before = await repoNames(window)
  const [first, second] = before

  // Onto the bottom half of the second group: below it.
  const target = window.locator('.repo-group', {
    has: window.locator(`[aria-label="Remove ${second}"]`)
  })
  const box = (await target.boundingBox())!
  await window
    .locator('.repo-head', { has: window.locator(`[aria-label="Remove ${first}"]`) })
    .dragTo(target, { targetPosition: { x: box.width / 2, y: box.height - 2 } })

  const after = [second, first, ...before.slice(2)]
  await expect.poll(() => repoNames(window)).toEqual(after)

  const next = await relaunch()
  await expect.poll(() => repoNames(next)).toEqual(after)
})
