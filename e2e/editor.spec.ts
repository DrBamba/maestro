import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * The embed's extensions have to be on disk *before* code-server starts.
 *
 * Its extension host scans the extensions directory once, a second or two after the server comes
 * up, and then lives for as long as the connection — which is the whole run of the app. An install
 * still writing when that scan happens produces the worst kind of failure: the extension is
 * correctly installed, `--list-extensions` agrees, and the editor behaves for days as though it
 * were not there. Python was invisible that way once already.
 *
 * Proven here by timestamps: code-server names its log directory for the moment it starts, so the
 * manifest being older than that directory is the ordering this depends on.
 */

async function hasCodeServer(): Promise<boolean> {
  try {
    await exec('which', ['code-server'])
    return true
  } catch {
    return false
  }
}

/** Start time of the server's only log session, from the `20260809T103700` directory name. */
function sessionStart(name: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name)
  if (!m) return NaN
  const [, y, mo, d, h, mi, s] = m
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime()
}

test('the editor has its extensions before code-server can scan them', async ({
  window,
  profileDir
}) => {
  test.skip(!(await hasCodeServer()), 'code-server is not installed on this machine')

  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'editor extensions')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('editor extensions', {
    timeout: 30_000
  })
  await window.click('.tab:has-text("Editor")')

  const embed = join(profileDir, 'code-server')
  const manifest = join(embed, 'extensions', 'extensions.json')

  /*
   * Every one of them, not the first to land. The CLI writes the manifest as each extension
   * finishes, so asserting on a single id passes while the rest are still unpacking — which is how
   * this test twice failed on the extension it was not waiting for.
   */
  const wanted = ['mhutchie.git-graph', 'ms-python.python', 'detachhead.basedpyright']
  await expect
    .poll(
      async () => {
        const raw = await readFile(manifest, 'utf8').catch(() => '')
        return wanted.filter((id) => raw.includes(id)).length
      },
      { timeout: 180_000, intervals: [500] }
    )
    .toBe(wanted.length)

  // One language server, decided from what actually installed rather than from what was asked for.
  const settings = await readFile(join(embed, 'User', 'settings.json'), 'utf8')
  expect(settings).toContain('"python.languageServer": "None"')

  // Plain VS Code's strictness: no type checking, but an unresolved import still says so.
  const parsed = JSON.parse(settings) as Record<string, unknown>
  expect(parsed['basedpyright.analysis.typeCheckingMode']).toBe('off')
  expect(parsed['basedpyright.analysis.diagnosticSeverityOverrides']).toMatchObject({
    reportMissingImports: 'warning'
  })

  /*
   * The server's log session, not the CLI's. Every `--install-extension` run opens a session of
   * its own under the same logs directory — holding a lone remoteCLI.log — and reading that one as
   * the server's start makes an install look like it finished after the server it preceded.
   */
  const logs = join(embed, 'logs')
  const serverSessions = async (): Promise<string[]> => {
    const found: string[] = []
    for (const name of await readdir(logs).catch(() => [])) {
      const files = await readdir(join(logs, name)).catch(() => [])
      if (files.includes('remoteagent.log')) found.push(name)
    }
    return found
  }
  // The server is spawned after the install, so on a cold profile its session appears last.
  await expect.poll(async () => (await serverSessions()).length, { timeout: 60_000 }).toBeGreaterThan(0)

  const started = Math.min(...(await serverSessions()).map(sessionStart))
  const written = (await stat(manifest)).mtimeMs
  expect(
    written,
    `manifest written ${new Date(written).toISOString()}, server started ${new Date(started).toISOString()}`
  ).toBeLessThanOrEqual(started + 1000)
})

/**
 * A link the workbench opens — Cmd+click on a URL in its terminal — is a popup from the guest, and
 * has to land in the browser. code-server's `/proxy/<port>/` rewrite of a localhost link is undone
 * on the way, so the browser gets the address the terminal printed.
 */
test('links opened in the editor go to the browser', async ({ window, app }) => {
  test.skip(!(await hasCodeServer()), 'code-server is not installed on this machine')

  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as unknown as { opened: string[] }).opened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })

  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', 'editor links')
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText('editor links', {
    timeout: 30_000
  })
  await window.click('.tab:has-text("Editor")')
  await expect(window.locator('webview')).toHaveCount(1, { timeout: 180_000 })

  const openFromGuest = (url: string): Promise<void> =>
    app.evaluate(async ({ webContents }, target) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview')
      if (!guest) throw new Error('no webview')
      // A user gesture, as a Cmd+click is; a popup without one is blocked before any handler.
      await guest.executeJavaScript(`window.open(${JSON.stringify(target)}, '_blank')`, true)
    }, url)
  const opened = (): Promise<string[]> =>
    app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)

  await expect
    .poll(async () => {
      await openFromGuest('https://example.com/docs').catch(() => {})
      return (await opened()).includes('https://example.com/docs')
    }, { timeout: 60_000, intervals: [1000] })
    .toBe(true)

  await openFromGuest('http://127.0.0.1:9/proxy/5173/app?x=1')
  await expect.poll(opened).toContain('http://localhost:5173/app?x=1')
})
