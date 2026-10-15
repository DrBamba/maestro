import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const exec = promisify(execFile)

/**
 * Jumping about from the keyboard.
 *
 * Every chord here has to do two things, and the second is the one worth testing: show a session,
 * pane or tab, and hand it the keyboard. A shortcut that reveals a terminal you then have to click
 * has done half the job — so where it can be, arrival is asserted by typing and finding the
 * characters at the far end, through the agent's log or through a file a shell wrote.
 */

async function createSession(window: Page, name: string): Promise<void> {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator(`.session-row__name:text-is("${name}")`)).toHaveCount(1, {
    timeout: 30_000
  })
}

/**
 * Which tab's pane the keyboard is in.
 *
 * Not just "a terminal has focus": every xterm's focus target is an identical textarea, so a chord
 * that showed the right tab while leaving the keyboard in the old one would pass that test and then
 * type into the wrong process — which is exactly what it did before this looked at the pane.
 */
function focusedPane(window: Page): Promise<string | null> {
  return window.evaluate(
    () => document.activeElement?.closest('[data-pane-key]')?.getAttribute('data-pane-key') ?? null
  )
}

async function keyboardIn(window: Page, key: string): Promise<void> {
  await expect.poll(() => focusedPane(window), { timeout: 15_000 }).toBe(key)
}

/** Scoped to the session on screen: every open session has a strip of its own, all but one hidden. */
function tab(window: Page, key: string): ReturnType<Page['locator']> {
  return window.locator(`main.session:visible .tab[data-tab-key="${key}"]`)
}

/** The name on the row the sidebar is showing as current. */
function activeRow(window: Page): ReturnType<Page['locator']> {
  return window.locator('.session-row.is-active .session-row__name')
}

/** Writes an agent state the way the real hooks do — see agent-state.spec.ts. */
async function say(profileDir: string, sessionId: string, word: string): Promise<void> {
  const dir = join(profileDir, 'agent-state')
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, `${sessionId}.state`), `${word}\n`, 'utf8')
}

function dotOf(window: Page, name: string): ReturnType<Page['locator']> {
  return window.locator('.session-row').filter({ hasText: name }).locator('.dot')
}

/**
 * Leaves nothing in flight before the app is torn down, and waits until the app agrees.
 *
 * Quitting on work in progress is a native confirmation dialog — right for a person, undriveable
 * from here — so a test that ends with a session still working hangs on close instead of finishing.
 * Writing the word is not enough: it is read asynchronously, so the dot is what confirms it landed.
 */
async function settle(window: Page, profileDir: string, sessions: Record<string, string>): Promise<void> {
  for (const [name, id] of Object.entries(sessions)) {
    await say(profileDir, id, 'idle')
    await expect(dotOf(window, name)).toHaveClass(/is-idle/)
  }
}

async function dragTab(window: Page, key: string, to: { x: number; y: number }): Promise<void> {
  const box = (await tab(window, key).boundingBox())!
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(to.x, to.y, { steps: 12 })
  await window.mouse.up()
}

/** The bracket chords exist only on macOS: elsewhere `Ctrl+[` is a terminal's Escape. */
const brackets = process.platform === 'darwin'

async function rightEdgeOf(window: Page, index: number): Promise<{ x: number; y: number }> {
  const box = (await window.locator('main.session:visible .board__frame').nth(index).boundingBox())!
  return { x: box.x + box.width - 8, y: box.y + box.height / 2 }
}

test('⌘] and ⌘[ walk the tabs of the focused pane, and wrap', async ({ window }) => {
  test.skip(!brackets, 'bracket chords are macOS-only')
  await createSession(window, 'walk the tabs')
  await expect(tab(window, 'claude')).toHaveClass(/is-on/)

  await window.keyboard.press('ControlOrMeta+]')
  await expect(tab(window, 'editor')).toHaveClass(/is-on/)
  await window.keyboard.press('ControlOrMeta+]')
  await expect(tab(window, 'console-1')).toHaveClass(/is-on/)

  // Past the end is the start again: three tabs in a strip is a ring, not a dead end.
  await window.keyboard.press('ControlOrMeta+]')
  await expect(tab(window, 'claude')).toHaveClass(/is-on/)
  await window.keyboard.press('ControlOrMeta+[')
  await expect(tab(window, 'console-1')).toHaveClass(/is-on/)
})

test('a tab reached by chord has the keyboard already', async ({ window, agentLog }) => {
  test.skip(!brackets, 'bracket chords are macOS-only')
  await createSession(window, 'keyboard follows')
  await keyboardIn(window, 'claude')

  const session = await window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions[0]))

  // Onto the console, whose shell starts the first time its tab reaches the screen. What it does
  // with what is typed is the assertion: terminal output only ever reaches a WebGL canvas.
  await window.keyboard.press('ControlOrMeta+[')
  await expect(tab(window, 'console-1')).toHaveClass(/is-on/)
  await keyboardIn(window, 'console-1')
  await window.keyboard.type('echo chorded > chorded.txt')
  await window.keyboard.press('Enter')
  await expect
    .poll(() => existsSync(join(session.worktreePath, 'chorded.txt')), { timeout: 20_000 })
    .toBe(true)

  // And back to Claude, which is the same claim in the other direction — the agent, not the shell,
  // receives what is typed next.
  await window.keyboard.press('ControlOrMeta+]')
  await expect(tab(window, 'claude')).toHaveClass(/is-on/)
  await keyboardIn(window, 'claude')
  await window.keyboard.type('back on claude')
  await window.keyboard.press('Enter')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('back on claude')
})

test('⌘⇧[ and ⌘⇧] step through the sessions in the sidebar', async ({ window }) => {
  test.skip(!brackets, 'bracket chords are macOS-only')
  await createSession(window, 'first one')
  await createSession(window, 'second one')
  await expect(activeRow(window)).toHaveText('second one')

  // Backwards from the second is the first; backwards again wraps to the end of the list.
  await window.keyboard.press('ControlOrMeta+Shift+[')
  await expect(activeRow(window)).toHaveText('first one')
  await window.keyboard.press('ControlOrMeta+Shift+[')
  await expect(activeRow(window)).toHaveText('second one')
  await window.keyboard.press('ControlOrMeta+Shift+]')
  await expect(activeRow(window)).toHaveText('first one')
})

test('⌘1 and ⌘9 go to a session by position', async ({ window }) => {
  await createSession(window, 'row one')
  await createSession(window, 'row two')
  await createSession(window, 'row three')

  await window.keyboard.press('ControlOrMeta+1')
  await expect(activeRow(window)).toHaveText('row one')
  await window.keyboard.press('ControlOrMeta+2')
  await expect(activeRow(window)).toHaveText('row two')

  // ⌘9 is the last row rather than the ninth, so it keeps working past nine sessions.
  await window.keyboard.press('ControlOrMeta+9')
  await expect(activeRow(window)).toHaveText('row three')

  // A digit past the end of the list is not a jump to nowhere.
  await window.keyboard.press('ControlOrMeta+8')
  await expect(activeRow(window)).toHaveText('row three')
})

test('the number chords count rows as the sidebar gathers them', async ({ window, profileDir }) => {
  const shared = join(profileDir, 'shared')
  const elsewhere = join(profileDir, 'elsewhere')
  await mkdir(shared, { recursive: true })
  await mkdir(elsewhere, { recursive: true })

  const open = async (folder: string, name: string): Promise<void> => {
    await window.click('[aria-label="New local session"]')
    await window.click('.seg__opt:has-text("One I already have")')
    await window.fill('#local-path', folder)
    await window.fill('#local-name', name)
    await window.click('.modal__actions .btn--primary')
    await expect(window.locator('.modal')).toHaveCount(0, { timeout: 30_000 })
  }

  /*
   * Opened in this order, but not listed in it: the two in the shared folder are gathered under it,
   * so the one opened between them reads last. ⌘2 is the second row a person sees, not the second
   * session made.
   */
  await open(shared, 'first here')
  await open(elsewhere, 'opened between')
  await open(shared, 'second here')
  await expect(window.locator('.repo-group--local .session-row__name')).toHaveText([
    'first here',
    'second here',
    'opened between'
  ])

  await window.keyboard.press('ControlOrMeta+2')
  await expect(activeRow(window)).toHaveText('second here')
  await window.keyboard.press('ControlOrMeta+3')
  await expect(activeRow(window)).toHaveText('opened between')
  if (brackets) {
    await window.keyboard.press('ControlOrMeta+Shift+]')
    await expect(activeRow(window)).toHaveText('first here')
  }
})

test('⌘⇧A goes to the session that is asking, then says there are no more', async ({
  window,
  profileDir
}) => {
  await createSession(window, 'asking me something')
  await createSession(window, 'being worked on')
  await expect(activeRow(window)).toHaveText('being worked on')

  const sessions = await window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions))
  const asking = sessions.find((s) => s.name === 'asking me something')!
  const working = sessions.find((s) => s.name === 'being worked on')!

  // One session mid-turn and one waiting on an answer: the chord's whole job is telling them apart.
  await say(profileDir, working.id, 'working')
  await say(profileDir, asking.id, 'attention')
  await expect(dotOf(window, 'asking me something')).toHaveClass(/is-attention/)
  await expect(dotOf(window, 'being worked on')).toHaveClass(/is-working/)

  await window.keyboard.press('ControlOrMeta+Shift+A')
  await expect(activeRow(window)).toHaveText('asking me something')

  /*
   * Pressing again does not land back on the session already on screen. Being looked at is the
   * thing the chord was for, so the queue is empty and it says so rather than doing nothing.
   */
  await window.keyboard.press('ControlOrMeta+Shift+A')
  await expect(window.locator('.toast')).toHaveText('Nothing else waiting on you')
  await expect(activeRow(window)).toHaveText('asking me something')

  await settle(window, profileDir, {
    'being worked on': working.id,
    'asking me something': asking.id
  })
})

test('⌘⇧arrows move the keyboard between panes', async ({ window, agentLog }) => {
  await createSession(window, 'two panes')
  await keyboardIn(window, 'claude')

  await dragTab(window, 'console-1', await rightEdgeOf(window, 0))
  const frames = window.locator('.board__frame')
  await expect(frames).toHaveCount(2)
  // The dragged pane is the one that was just touched, so it is the one holding the keyboard.
  await expect(frames.nth(1)).toHaveClass(/is-focused/)

  await window.keyboard.press('ControlOrMeta+Shift+ArrowLeft')
  await expect(frames.nth(0)).toHaveClass(/is-focused/)
  await expect(frames.nth(1)).not.toHaveClass(/is-focused/)

  // Focused means typeable, not merely outlined: Claude is in the left pane and gets the keys.
  await keyboardIn(window, 'claude')
  await window.keyboard.type('moved left')
  await window.keyboard.press('Enter')
  await expect.poll(agentLog, { timeout: 15_000 }).toContain('moved left')

  await window.keyboard.press('ControlOrMeta+Shift+ArrowRight')
  await expect(frames.nth(1)).toHaveClass(/is-focused/)
  await keyboardIn(window, 'console-1')

  // Nothing lies that way, so the chord is inert rather than wrapping around to the other side.
  await window.keyboard.press('ControlOrMeta+Shift+ArrowRight')
  await expect(frames.nth(1)).toHaveClass(/is-focused/)
  expect(await focusedPane(window)).toBe('console-1')
})

/**
 * The editor pane, which is the one place none of this works by itself: a `<webview>` is a process
 * of its own, so a chord pressed in VS Code never reaches the window's keydown listener. Main takes
 * the session jumps there and forwards them, and leaves every other chord to the workbench.
 *
 * Driven through the pane's own webContents, which is what the interception actually listens to.
 */
async function hasCodeServer(): Promise<boolean> {
  try {
    await exec('which', ['code-server'])
    return true
  } catch {
    return false
  }
}

async function pressInEditor(
  app: Parameters<Parameters<typeof test>[1]>[0]['app'],
  keyCode: string,
  modifiers: string[]
): Promise<void> {
  await app.evaluate(
    ({ webContents }, key) => {
      const view = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
      view?.sendInputEvent({
        type: 'keyDown',
        keyCode: key.keyCode,
        modifiers: key.modifiers
      } as never)
    },
    { keyCode, modifiers }
  )
}

test('tab and session jumps work from inside the editor, and pane moves stay its own', async ({
  window,
  app
}) => {
  test.skip(!(await hasCodeServer()), 'code-server is not installed on this machine')
  // The workbench has to actually come up before there is a webview to press a key into, and on a
  // cold profile that is minutes: extensions install first, and the server starts after them.
  test.setTimeout(240_000)

  await createSession(window, 'the other one')
  await createSession(window, 'the editor one')
  await keyboardIn(window, 'claude')

  // Two panes, so a pane move that was taken would be visible: Claude and Editor on the left.
  await dragTab(window, 'console-1', await rightEdgeOf(window, 0))
  const frames = window.locator('main.session:visible .board__frame')
  await expect(frames).toHaveCount(2)
  await tab(window, 'editor').click()
  await expect(tab(window, 'editor')).toHaveClass(/is-on/)
  await expect(frames.nth(0)).toHaveClass(/is-focused/)

  const webviews = (): Promise<number> =>
    app.evaluate(
      ({ webContents }) =>
        webContents.getAllWebContents().filter((w) => w.getType() === 'webview').length
    )

  /*
   * Skipped rather than failed if it never arrives. There is nothing to press a key into until the
   * workbench exists, and on a loaded machine a cold code-server can take longer than any deadline
   * worth setting — which is a fact about this machine, not a claim about the interception.
   */
  const deadline = Date.now() + 180_000
  while ((await webviews()) === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  test.skip((await webviews()) === 0, 'code-server did not come up in time on this machine')

  await keyboardIn(window, 'editor')

  // ⌘⇧→ selects to the end of a line in VS Code, and stays that: the keyboard does not change pane.
  await pressInEditor(app, 'Right', ['meta', 'shift'])
  await expect(frames.nth(0)).toHaveClass(/is-focused/)
  expect(await focusedPane(window)).toBe('editor')

  /*
   * ⌘] is taken, and the keyboard leaves with it. This was the dead end: the tab chords worked
   * everywhere but here, so the only way out of the editor was the mouse.
   */
  await pressInEditor(app, ']', ['meta'])
  await expect(tab(window, 'claude')).toHaveClass(/is-on/)
  await keyboardIn(window, 'claude')

  // And a session jump, from back inside the editor.
  await tab(window, 'editor').click()
  await keyboardIn(window, 'editor')
  await pressInEditor(app, '1', ['meta'])
  await expect(activeRow(window)).toHaveText('the other one')
})

test('nothing navigates behind an open dialog', async ({ window }) => {
  await createSession(window, 'stay put')
  await createSession(window, 'the one in front')
  await expect(activeRow(window)).toHaveText('the one in front')

  await window.keyboard.press('ControlOrMeta+N')
  await expect(window.locator('.modal')).toBeVisible()

  // The session name being typed into the dialog is the thing in hand; a digit must not switch the
  // window out from under it.
  await window.keyboard.press('ControlOrMeta+1')
  await expect(window.locator('.modal')).toBeVisible()
  await expect(activeRow(window)).toHaveText('the one in front')

  await window.keyboard.press('Escape')
  await window.keyboard.press('ControlOrMeta+1')
  await expect(activeRow(window)).toHaveText('stay put')
})
