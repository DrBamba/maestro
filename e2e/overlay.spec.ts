import { test, expect } from './fixtures'

/**
 * Guards the one class of dead button no click test can catch.
 *
 * macOS resolves `-webkit-app-region: drag` from the region's geometry, in the browser process,
 * before the renderer is involved at all — so a real press inside a drag region becomes a window
 * drag and the DOM never sees a click. Both `.empty` and `.session__header` are drag regions that
 * a dialog opens over, which is how "Create session" came to do nothing while Enter still worked.
 *
 * Playwright's clicks are injected straight into the renderer, so they land on the button whether
 * or not a drag region covers it: `createSession()` in shell.spec.ts clicked this exact button
 * throughout, and passed throughout. What is assertable is the invariant — an overlay must cancel
 * the regions underneath it — so that is what these check.
 */

/** The used value of -webkit-app-region for a selector, as the compositor would see it. */
const region = (selector: string): string =>
  `getComputedStyle(document.querySelector('${selector}')).webkitAppRegion`

test('the empty state is a drag region spanning the whole content area', async ({ window }) => {
  // The premise of the bug: with nothing running, one drag region covers everywhere a dialog opens.
  await expect(window.locator('.empty')).toBeVisible()
  expect(await window.evaluate(region('.empty'))).toBe('drag')

  const covers = await window.evaluate(() => {
    const r = document.querySelector('.empty')!.getBoundingClientRect()
    return r.height >= window.innerHeight - 1 && r.right >= window.innerWidth - 1
  })
  expect(covers).toBe(true)
})

test('an open dialog cancels the drag region under its buttons', async ({ window }) => {
  await window.click('[aria-label="New session in demo-api"]')
  await expect(window.locator('.modal')).toBeVisible()

  // no-drag on the scrim subtracts the whole window, so nothing painted below can claim a press.
  expect(await window.evaluate(region('.scrim'))).toBe('no-drag')

  const { scrimCoversWindow, buttonInsideOldDragRegion } = await window.evaluate(() => {
    const scrim = document.querySelector('.scrim')!.getBoundingClientRect()
    const button = document.querySelector('.modal__actions .btn--primary')!.getBoundingClientRect()
    const empty = document.querySelector('.empty')!.getBoundingClientRect()
    const x = button.left + button.width / 2
    const y = button.top + button.height / 2
    return {
      scrimCoversWindow:
        scrim.width >= window.innerWidth - 1 && scrim.height >= window.innerHeight - 1,
      buttonInsideOldDragRegion:
        x > empty.left && x < empty.right && y > empty.top && y < empty.bottom
    }
  })

  expect(scrimCoversWindow).toBe(true)
  // Without the scrim's no-drag this overlap is exactly what ate the press.
  expect(buttonInsideOldDragRegion).toBe(true)
})

test('Create session is never gated — not by a name, not by the base list', async ({ window }) => {
  await window.click('[aria-label="New session in demo-api"]')
  const create = window.locator('.modal__actions .btn--primary')

  /*
   * Live from the moment the dialog opens, which is the strongest form of the rule it is here for:
   * the button may require nothing Enter does not. It used to insist on a loaded `base`, leaving it
   * dead for as long as the option list took to arrive — around 20ms, measured, which is why it read
   * as an intermittently dead button rather than a broken one. Asserting before anything is typed
   * catches that without having to race the fetch. An empty base is not an error state either:
   * createSession reads it as the repo's default branch.
   *
   * Nor is an empty message. It is the other way into a session — Claude opens on its own prompt.
   */
  await expect(create).toBeEnabled()

  await window.fill('#session-name', 'named only')
  await expect(create).toBeEnabled()
})
