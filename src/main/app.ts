import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { store } from './store'
import { ptys } from './pty'
import { agentStates } from './agentState'
import { codeServer } from './codeServer'
import { titleWatcher } from './autoTitle'
import { registerIpc, restoreAgentStates, wireAgentStates, wireAutoTitle, wireTheme } from './ipc'
import { resolvedTheme } from './theme'
import { THEMES } from '@shared/theme'
import { configureProfile, profile, resolveSourceLabel } from './profile'
import { hydratePath } from './shellEnv'
import { seedDemoRepos } from './demo'
import { platformOf } from '@shared/platform'
import { matchShortcut, reachesEditor } from '@shared/shortcuts'
import { updater } from './updater'

const platform = platformOf(process.platform)

const dirname = fileURLToPath(new URL('.', import.meta.url))

// Already done by the boot loader (index.ts); repeated because a release carries its own copy.
configureProfile()

/*
 * The other half of the .desktop contract, and useless without it: the packaged app installs
 * `io.github.drbamba.maestro.desktop`, and a desktop environment matches a running window to that entry by
 * comparing it against the window's own app id — which Electron derives from this name, defaulting
 * to `${app.name}.desktop`. Left alone, the window would announce itself as `Maestro.desktop`, no
 * entry by that name would exist, and the dock would show a second nameless icon beside the
 * launcher rather than lighting up the one already there.
 */
if (platform === 'linux') app.setDesktopName('io.github.drbamba.maestro.desktop')

/** Set by the e2e suite so a test run cannot steal focus from whatever else is happening. */
const headless = process.env.MAESTRO_HEADLESS === '1'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: profile() === 'stable' ? 'Maestro' : `Maestro — ${profile()}`,
    width: 1512,
    height: 960,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    // What is painted before the renderer has anything on screen, and behind it during a resize.
    backgroundColor: THEMES[resolvedTheme()].chrome,
    /*
     * The design puts the window controls inside the sidebar's top-left. Rather than drawing
     * imitations, we keep the real ones and place them where the design shows them — but both of
     * these options are macOS-only. On Linux they are ignored, so the window keeps its native
     * title bar and the sidebar must not reserve the gutter those controls would have sat in;
     * `data-platform` on the document tells the stylesheet which of the two it is looking at.
     */
    ...(platform === 'mac'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }
      : {}),
    /*
     * Linux and Windows get Electron's default menu bar, which would otherwise sit as a second
     * strip above a UI that already has its own header. Hidden rather than removed: the menu is
     * what supplies Ctrl+Q, Ctrl+C and Ctrl+V, and deleting it would take those with it. Alt
     * brings it back for anyone who wants it.
     */
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      /*
       * Terminals must keep painting when the window is not in front. Chromium throttles timers
       * and rAF for occluded windows, which would stall a running agent's output — and would stop
       * the automated tests working at all, since they drive a window that is never shown.
       */
      backgroundThrottling: false,
      // code-server is embedded in a <webview> (PLAN.md §2).
      webviewTag: true
    }
  })

  /*
   * Under test the window is never shown. An Electron window takes focus when it appears, which
   * would make the suite unusable alongside anything else on the machine — you cannot type while
   * it runs. The renderer still lays out and still tracks document focus, so everything the tests
   * assert behaves identically; it simply does so out of sight.
   */
  if (headless) {
    if (platform === 'mac') app.dock?.hide()
  } else {
    mainWindow.on('ready-to-show', () => mainWindow?.show())
  }

  /*
   * A renderer that dies leaves a blank window and says nothing, which made a crash on session
   * delete impossible to diagnose after the fact — no exception, no report, just a missing process.
   * Record why, and offer to reload rather than leaving an empty frame.
   */
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const line = `[maestro] renderer gone: reason=${details.reason} exitCode=${details.exitCode}`
    console.error(line)
    void appendFile(join(app.getPath('userData'), 'crash.log'), `${new Date().toISOString()} ${line}\n`).catch(
      () => {}
    )

    void dialog
      .showMessageBox({
        type: 'error',
        buttons: ['Reload', 'Ignore'],
        defaultId: 0,
        message: 'Maestro’s window stopped responding',
        detail: `The interface process ended (${details.reason}). Terminals keep running — reloading reattaches to them.\n\nLogged to crash.log in the app’s data directory.`
      })
      .then(({ response }) => {
        if (response === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
      })
  })

  // Uncaught renderer exceptions do not kill the process, so they would otherwise be invisible.
  ipcMain.on('app:renderer-error', (_e, message: string) => {
    console.error('[renderer]', message)
    void appendFile(
      join(app.getPath('userData'), 'crash.log'),
      `${new Date().toISOString()} [renderer] ${message}\n`
    ).catch(() => {})
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  ptys.attach(mainWindow.webContents)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * The chords that have to work from inside the editor pane.
 *
 * That pane is a `<webview>`, a process of its own, so keys pressed in it never reach the window's
 * keydown listener — without this, jumping to another tab or session would stop working in the pane
 * people spend the longest in. Taken here, before the workbench sees them, and handed to the
 * renderer as the same chord it would have read itself.
 */
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const chord = {
      key: input.key,
      code: input.code,
      shift: input.shift,
      meta: input.meta,
      control: input.control
    }
    const shortcut = matchShortcut(chord, platform === 'mac')
    if (!shortcut || !reachesEditor(shortcut)) return
    event.preventDefault()
    mainWindow?.webContents.send('shortcut', chord)
  })
})

void app.whenReady().then(async () => {
  console.log(`[maestro] profile=${profile()} userData=${app.getPath('userData')}`)

  // Before anything spawns a process: a GUI launch starts with launchd's minimal PATH, which does
  // not include claude, gh or code-server.
  const path = await hydratePath()
  console.log(
    `[maestro] PATH ${path.resolved ? 'from login shell' : 'from fallbacks'}` +
      (path.added.length ? `, added ${path.added.length} dir(s)` : ', already complete')
  )

  const source = await resolveSourceLabel()
  if (source) console.log(`[maestro] running from ${source}`)

  store.load()
  // Printed after load so the path is the one actually read, not the one intended.
  console.log(`[maestro] store=${store.path} (${store.sessions.length} session(s))`)
  // Gives a dev profile something safe to work on, so real repos are not the obvious thing to add.
  await seedDemoRepos()
  // Before the window: it takes its background colour from the resolved theme, and the native
  // chrome around it has to be told which one that is.
  wireTheme()
  /*
   * Before agent states are restored: a Claude that is still running in the terminal host — this
   * process replaced by an update while it worked — is not an interrupted one.
   */
  try {
    await ptys.connect()
  } catch (err) {
    dialog.showErrorBox('Maestro could not start its terminals', String(err))
    app.exit(1)
    return
  }
  await agentStates.start()
  // Restored before the listener is attached: these states are being read back, not happening, and
  // wiring first meant every session that came back asking for input fired an OS notification
  // saying so at launch.
  restoreAgentStates()
  wireAgentStates()
  wireAutoTitle()
  registerIpc()
  createWindow()
  updater.start({ window: () => mainWindow, prepareRelaunch, restart: restartForUpdate })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (platform !== 'mac') app.quit()
})

/**
 * Quitting kills every Claude process. Doing that silently while an agent is mid-task leaves a
 * transcript that stops mid-sentence with nothing to say why — so confirm first, record which
 * sessions were cut off, and give the processes a moment to flush rather than pulling the plug.
 */
let shuttingDown = false

/** Set by the update button when an update needs a real restart; cleared if the quit is called off. */
let relaunchAfterQuit = false

function restartForUpdate(): void {
  relaunchAfterQuit = true
  app.quit()
}

/**
 * Everything quitting does except ending the terminals: an update relaunches the app around its
 * running agents, and the next main process reconnects to them.
 */
function prepareRelaunch(): void {
  shuttingDown = true
  updater.stop()
  agentStates.stop()
  titleWatcher.stop()
  codeServer.stop()
  store.flushNow()
  ptys.detach()
}

app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()

  void (async () => {
    const live = ptys.liveClaudeSessions()
    // A sub-agent still out counts as working: quitting cuts that off exactly the same way.
    const working = live.filter((id) => ['working', 'delegating'].includes(agentStates.get(id)))

    if (working.length > 0) {
      const names = working
        .map((id) => store.session(id)?.name ?? 'a session')
        .slice(0, 5)
        .map((name) => `  • ${name}`)
        .join('\n')
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Quit anyway', 'Keep working'],
        defaultId: 1,
        cancelId: 1,
        message: `Claude is still working in ${working.length} session${working.length === 1 ? '' : 's'}`,
        detail: `${names}\n\nQuitting stops ${working.length === 1 ? 'it' : 'them'} mid-task. Conversations are kept and can be resumed; work in flight is lost.`
      })
      if (response === 1) {
        relaunchAfterQuit = false
        return
      }
    }

    // Remember what was interrupted so the next launch can say so.
    const now = Date.now()
    for (const id of working) store.updateSession(id, { interruptedAt: now })

    shuttingDown = true
    // Frozen before the agents are killed, so their dying does not overwrite what they were doing.
    agentStates.stop()
    await ptys.shutdown()
    titleWatcher.stop()
    codeServer.stop()
    store.flushNow()
    // Under test the next instance is started by the test, which cannot follow a relaunch.
    if (relaunchAfterQuit && process.env.MAESTRO_NO_RELAUNCH !== '1') app.relaunch()
    app.quit()
  })()
})
