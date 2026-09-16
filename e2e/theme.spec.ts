import type { Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * Light mode is three programs agreeing, not one stylesheet.
 *
 * The shell reads a CSS token, xterm draws into a canvas that cannot see one, and the editor is a
 * separate process reading a settings file — so "the app is light" is only true if all three are,
 * and each of them can fail on its own. A shell that turns white around a terminal still painting
 * near-black is the failure this guards, and it is invisible to any assertion about the document.
 */

/** What the shell resolved to, as every rule in app.css reads it. */
const shellTheme = (window: Page): Promise<string | undefined> =>
  window.evaluate(() => document.documentElement.dataset.theme)

/**
 * The ground the terminal is drawing on, taken from xterm rather than from our own stylesheet.
 *
 * xterm paints its cells into a canvas no assertion can read, but it also writes the theme's
 * background onto the viewport element as an inline style — both when the terminal is created and
 * again whenever its theme is replaced. That inline value is xterm's answer, not ours, which is
 * what makes it worth asserting on.
 */
const terminalBackground = (window: Page): Promise<string> =>
  window.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.term .xterm-viewport')
    return viewport?.style.backgroundColor ?? ''
  })

async function chooseTheme(window: Page, label: string): Promise<void> {
  await window.click('[aria-label="Settings"]')
  await expect(window.locator('[aria-label="Appearance"]')).toBeVisible()
  await window.click(`[aria-label="Appearance"] .seg__opt:has-text("${label}")`)
  await window.click('.modal__actions .btn--primary')
}

test('the app starts dark, because that is what it was before the setting existed', async ({
  window
}) => {
  expect(await shellTheme(window)).toBe('dark')

  await window.click('[aria-label="Settings"]')
  const on = window.locator('[aria-label="Appearance"] .seg__opt[aria-pressed="true"]')
  await expect(on).toHaveText('Dark')
})

test('choosing light repaints the shell and the terminal it is holding', async ({ window }) => {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'light mode')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('light mode', {
    timeout: 30_000
  })

  /*
   * Read before the switch, and asserted to be dark first. Without that the test would pass on an
   * app that never themed its terminal at all — the check has to prove the value changed, not
   * merely that it ended up somewhere plausible.
   */
  await expect.poll(() => terminalBackground(window), { timeout: 15_000 }).toBe('rgb(10, 10, 13)')

  await chooseTheme(window, 'Light')

  expect(await shellTheme(window)).toBe('light')
  // The shell's own ground, proving the token swap reached a painted element and not just :root.
  const body = await window.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(body).toBe('rgb(242, 243, 248)')

  /*
   * The terminal was mounted before the switch and stays mounted through it — that is what keeps
   * scrollback across a tab change — so this is the recolour-in-place path, not a remount.
   */
  await expect.poll(() => terminalBackground(window), { timeout: 5_000 }).toBe('rgb(255, 255, 255)')
})

test('the embedded editor is told, and the choice survives a relaunch', async ({
  window,
  profileDir,
  relaunch
}) => {
  await chooseTheme(window, 'Light')

  /*
   * The settings file, not the workbench. code-server may not be installed on the machine running
   * this, and the file is what decides the embed's theme either way: VS Code watches it and
   * repaints from an external edit, which is how a running editor is recoloured without a restart.
   */
  const settings = join(profileDir, 'code-server', 'User', 'settings.json')
  await expect
    .poll(async () => readFile(settings, 'utf8').catch(() => ''), { timeout: 15_000 })
    .toContain('Default Light Modern')

  const written = JSON.parse(await readFile(settings, 'utf8'))
  // The editor's own ground, which has to be the shell's — one app, one surface.
  expect(written['workbench.colorCustomizations']['editor.background']).toBe('#ffffff')

  /*
   * Asserted separately from what the next launch paints, so a failure says which half broke: the
   * choice never reaching disk, or reaching it and not being read back. Polled because the store
   * batches its writes — the UI changes far more often than the disk needs to.
   */
  await expect
    .poll(
      async () => {
        const raw = await readFile(join(profileDir, 'maestro.json'), 'utf8').catch(() => '{}')
        return JSON.parse(raw).preferences?.theme
      },
      { timeout: 5_000 }
    )
    .toBe('light')

  /*
   * Not polled. The document carries its theme before React has rendered anything at all, which is
   * the whole point — polling would let a launch that opens dark and corrects itself a frame later
   * pass as though it had opened light.
   */
  const next = await relaunch()
  expect(await shellTheme(next)).toBe('light')
})

async function hasCodeServer(): Promise<boolean> {
  try {
    await exec('which', ['code-server'])
    return true
  } catch {
    return false
  }
}

/**
 * The embed's own answer, read from inside the guest.
 *
 * `vs` / `vs-dark` is the class VS Code puts on its workbench for the theme in force, and the
 * --vscode-* properties beside it are the colours it resolved after our customizations were
 * folded in. Asserting on those is asserting on what the editor decided, not on what we asked for.
 */
const workbenchTheme = (window: Page): Promise<string> =>
  window
    .evaluate(async () => {
      const view = document.querySelector('webview') as { executeJavaScript?: (s: string) => Promise<string> } | null
      if (!view?.executeJavaScript) return 'no-webview'
      try {
        return await view.executeJavaScript(
          `(() => {
             const wb = document.querySelector('.monaco-workbench');
             if (!wb) return 'loading';
             const cs = getComputedStyle(wb);
             return (wb.className.match(/vs(-dark|-hc[a-z]*)?\\b/) || ['?'])[0]
               + ' editor=' + cs.getPropertyValue('--vscode-editor-background').trim()
               + ' sideBar=' + cs.getPropertyValue('--vscode-sideBar-background').trim();
           })()`
        )
      } catch {
        return 'guest-busy'
      }
    })
    .catch(() => 'host-busy')

/*
 * The embedded workbench is the one surface that cannot be repainted where it stands: it reads its
 * colours from a settings file once, as it loads, and ignores that file thereafter — measured, not
 * assumed. So the shell rewrites the file and then reloads the embed, and what this proves is the
 * half that decides whether the reload is worth anything: a workbench loading under a light
 * setting really does come up light, in the shell's own tokens rather than stock VS Code's.
 *
 * The reload itself is deliberately not driven here. A <webview> reload detaches Playwright from
 * the *host* page a few seconds later — reproduced with a bare `webview.reload()` and none of the
 * app's code involved — so a test of it would be testing the harness's tolerance, not the app.
 */
test('the embed comes up in the shell’s colours, not stock VS Code’s', async ({ window }) => {
  test.skip(!(await hasCodeServer()), 'code-server is not installed on this machine')
  test.setTimeout(240_000)

  // Chosen before the editor is ever opened, so this is the load path, not the reload path.
  await chooseTheme(window, 'Light')

  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'editor in light')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('editor in light', {
    timeout: 30_000
  })
  await window.click('.tab:has-text("Editor")')

  // First launch may install extensions before the server starts, which is minutes on a cold cache.
  await expect
    .poll(() => workbenchTheme(window), { timeout: 180_000, intervals: [2000] })
    .toContain('editor=#')

  const resolved = await workbenchTheme(window)
  // `vs` alone is VS Code's light workbench; `vs-dark` would mean the setting never landed.
  expect(resolved).toMatch(/^vs /)
  expect(resolved).toContain('editor=#ffffff')
  // --shell-panel: the embed's side bar and the shell's chrome are the same surface.
  expect(resolved).toContain('sideBar=#eef0f6')
})
