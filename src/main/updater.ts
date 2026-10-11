import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestProgress, UpdateStatus } from '@shared/types'
import { HOST_PROTOCOL } from './ptyProtocol'
import { ptys } from './pty'
import { Releases, readStamp, releasesDir, type ReleaseStamp } from './releases'
import { resolveBinary } from './shellEnv'
import { store } from './store'
import { landOnBase } from './git'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

/** How long a new window gets to ask for its first snapshot before the release is called broken. */
const WINDOW_DEADLINE_MS = Number(process.env.MAESTRO_WINDOW_DEADLINE_MS) || 30_000
/**
 * The fallback rhythm. `main` moving writes a file this watches, so this is only for the cases a
 * watch misses — a packed ref, a filesystem that does not report, a release published elsewhere.
 */
const POLL_MS = Number(process.env.MAESTRO_UPDATE_POLL_MS) || 60_000
/** How often the repository is fetched, when the setting asks for it. */
const FETCH_MS = Number(process.env.MAESTRO_UPDATE_FETCH_MS) || 5 * 60_000

/** Where the next window finds the note that it is an update. */
export const UPDATED_KEY = 'app:updated'

interface UpdaterOptions {
  window: () => BrowserWindow | null
  /** Lets go of everything a relaunch would otherwise kill or lose. Terminals are left running. */
  prepareRelaunch: () => void
  /** Quits the way the user would, agents and all, and starts again. */
  restart: () => void
}

/**
 * Keeps the update button honest, and does what it says when pressed.
 *
 * It watches two things: `main` in the repository the running build came from, and releases
 * published to this profile (by an earlier press, or by `npm run release`). Nothing is applied until
 * the button is pressed. Pressing builds and tests `main` if that is what is new — the same
 * `scripts/release.mjs` a terminal would run — then switches over.
 *
 * Switching is a window reload when main and preload are byte-identical to the running ones, and a
 * relaunch otherwise; either is safe because terminals live in the host. A build that needs a new
 * terminal host cannot be switched to live, so the button offers a real restart instead.
 */
class Updater {
  private releases: Releases | null = null
  private running: ReleaseStamp | null = null
  /** The release whose renderer the window shows — ahead of `running` after a window-only update. */
  private shown = ''
  private busy = false
  /** The button was pressed: apply the next release that is ready. */
  private wanted = false
  private status: UpdateStatus = { state: 'none' }
  /** The `main` a failure was for; a new commit clears it. */
  private failedAt = ''
  /** The `main` commit last seen ahead of the running build. */
  private aheadAt = ''
  private child: ChildProcess | null = null
  private refreshing = false
  private again = false
  private watcher: FSWatcher | null = null
  private refWatchers: FSWatcher[] = []
  /** The repository the ref watches are on, so they follow a build that came from another. */
  private watchedRepo = ''
  private poll: NodeJS.Timeout | null = null
  private fetchTimer: NodeJS.Timeout | null = null
  private fetching = false
  private nudge: NodeJS.Timeout | null = null
  private deadline: NodeJS.Timeout | null = null
  private options: UpdaterOptions | null = null

  start(options: UpdaterOptions): void {
    ipcMain.handle('update:status', () => this.status)
    ipcMain.on('update:press', () => this.press())
    ipcMain.on('update:log', () => void shell.openPath(this.logFile()))
    ipcMain.on('ui:busy', (_e, busy: boolean) => {
      this.busy = busy
      if (!busy) void this.refresh()
    })

    if (!app.isPackaged && process.env.MAESTRO_RELEASES !== '1') return
    this.options = options
    this.releases = new Releases(releasesDir(app.getPath('userData')))
    this.running = readStamp(join(here, '..'))
    // Tests run `out/`, which names the checkout that built it; its `main` must not move under them.
    const source = process.env.MAESTRO_SOURCE_REPO
    if (this.running && source !== undefined) this.running = { ...this.running, repo: source }
    this.shown = process.env.MAESTRO_RELEASE_ID || this.running?.id || ''

    mkdirSync(this.releases.dir, { recursive: true })
    try {
      this.watcher = watch(this.releases.dir, () => void this.refresh())
    } catch {
      // Polling below covers it.
    }
    this.poll = setInterval(() => void this.refresh(), POLL_MS)
    this.poll.unref()
    this.watchBranch()
    this.fetchTimer = setInterval(() => void this.fetchRemote(), FETCH_MS)
    this.fetchTimer.unref()
    void this.fetchRemote()
    void this.refresh()
  }

  /** The window asked for its first snapshot: whatever it was loaded from works. */
  windowReady(): void {
    if (!this.releases) return
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
    // Only a published release has a record to keep; the app's own build needs none.
    if (this.releases.usable(this.shown)) this.releases.markHealthy(this.shown)
    void this.refresh()
  }

  stop(): void {
    this.watcher?.close()
    for (const watcher of this.refWatchers) watcher.close()
    if (this.poll) clearInterval(this.poll)
    if (this.fetchTimer) clearInterval(this.fetchTimer)
    if (this.nudge) clearTimeout(this.nudge)
    this.child?.kill()
  }

  /**
   * Watches the file git writes when `main` moves, so a merge is noticed at once rather than at the
   * next poll — and so the poll can be slow enough to cost nothing.
   */
  private watchBranch(): void {
    const repo = this.live()?.repo ?? ''
    if (repo === this.watchedRepo) return
    this.watchedRepo = repo
    for (const watcher of this.refWatchers.splice(0)) watcher.close()
    const gitDir = join(repo, '.git')
    if (!existsSync(gitDir)) return
    const soon = (): void => {
      // Several writes land per ref update, and a fetch touches these files repeatedly.
      if (this.nudge) clearTimeout(this.nudge)
      this.nudge = setTimeout(() => void this.refresh(), 400)
    }
    for (const [dir, name] of [
      [join(gitDir, 'refs', 'heads'), 'main'],
      // Housekeeping can fold the loose ref into this one file instead.
      [gitDir, 'packed-refs']
    ]) {
      try {
        this.refWatchers.push(watch(dir, (_event, file) => file === name && soon()))
      } catch {
        // No watch here; the poll still covers it.
      }
    }
  }

  /** The setting was just switched on. */
  checkRemote(): void {
    void this.fetchRemote()
  }

  /**
   * Brings the repository's `main` up to date with the remote, when the setting asks for it.
   *
   * A fast-forward only, and only from a clean worktree — exactly what a `git pull` on an untouched
   * `main` would do. A `main` that has moved locally is left alone; its own commits are already
   * ahead of the remote's.
   */
  private async fetchRemote(): Promise<void> {
    const repo = this.live()?.repo
    if (!repo || !store.preferences.remoteUpdates || this.fetching || this.child) return
    this.fetching = true
    try {
      await exec('git', ['-C', repo, 'fetch', '--quiet', 'origin', 'main'], { timeout: 120_000 })
      await landOnBase(repo, 'main', 'origin/main')
      await this.refresh()
    } catch (err) {
      // No remote, no network, nothing to fast-forward: all normal, and all the button can say is
      // that there is no update.
      console.log(`[maestro] fetch for updates: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.fetching = false
    }
  }

  private logFile(): string {
    return join(this.releases?.dir ?? app.getPath('userData'), 'release.log')
  }

  private setStatus(next: UpdateStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.status)) return
    this.status = next
    const window = this.options?.window()
    if (window && !window.isDestroyed()) window.webContents.send('update:status', next)
  }

  /** What the window is running, as far as updates are concerned. */
  private live(): ReleaseStamp | null {
    return this.releases?.usable(this.shown) ?? this.running
  }

  /** A published release newer than what is on screen. */
  private ready(): ReleaseStamp | null {
    const releases = this.releases
    if (!releases) return null
    const stamp = releases.usable(releases.current())
    if (!stamp || stamp.id === this.shown) return null
    // A reinstalled app can be newer than the last release; that one stays.
    return stamp.builtAt > (this.running?.builtAt ?? 0) ? stamp : null
  }

  /** `main`, when it has commits the running build does not. */
  private async ahead(): Promise<{ commit: string; changes: number; subject: string } | null> {
    const live = this.live()
    if (!live?.repo || !existsSync(live.repo)) return null
    const git = async (...args: string[]): Promise<string> =>
      (await exec('git', ['-C', live.repo, ...args], { timeout: 5000 })).stdout.trim()
    try {
      const commit = await git('rev-parse', '--verify', 'refs/heads/main')
      if (commit === live.commit) return null
      // Only forward: a build from a branch `main` has not caught up with is not behind it.
      await git('merge-base', '--is-ancestor', live.commit, commit)
      const changes = Number(await git('rev-list', '--count', `${live.commit}..${commit}`))
      return { commit, changes, subject: await git('log', '-1', '--format=%s', commit) }
    } catch {
      return null
    }
  }

  private async refresh(): Promise<void> {
    if (!this.releases || this.child || this.deadline) return
    // One at a time, but a press during one must not be lost: run again once it is done.
    if (this.refreshing) {
      this.again = true
      return
    }
    this.refreshing = true
    try {
      // An update can bring a build from a different checkout; the watches follow it.
      this.watchBranch()
      const ready = this.ready()
      if (ready && this.wanted) return this.apply(ready)
      this.wanted = false

      const ahead = await this.ahead()
      this.aheadAt = ahead?.commit ?? ''
      if (this.status.state === 'failed' && this.aheadAt === this.failedAt) return

      if (ready && ready.hostProtocol !== HOST_PROTOCOL) {
        this.setStatus({ state: 'restart', subject: ready.subject })
      } else if (ahead && ahead.commit !== ready?.commit) {
        this.setStatus({ state: 'available', changes: ahead.changes, subject: ahead.subject })
      } else if (ready) {
        this.setStatus({ state: 'ready', subject: ready.subject })
      } else {
        this.setStatus({ state: 'none' })
      }
    } finally {
      this.refreshing = false
      if (this.again) {
        this.again = false
        void this.refresh()
      }
    }
  }

  private press(): void {
    switch (this.status.state) {
      case 'ready':
        this.wanted = true
        void this.refresh()
        return
      case 'available':
      case 'failed':
        this.build()
        return
      case 'restart':
        this.options?.restart()
        return
    }
  }

  /** Runs the release script for `main`, then applies what it publishes. */
  private build(): void {
    const repo = this.live()?.repo
    const fail = (message: string, at = this.aheadAt): void => {
      this.wanted = false
      this.failedAt = at
      this.setStatus({ state: 'failed', message })
    }
    if (!repo) return fail('This build cannot update itself. Run npm run install-stable once.')
    const script = join(repo, 'scripts', 'release.mjs')
    if (!existsSync(script)) return fail(`scripts/release.mjs is missing from ${repo}.`)
    const node = resolveBinary('node')
    if (!node) return fail('node is not on PATH. Install Node, then retry.')

    this.wanted = true
    this.setStatus({ state: 'building', step: 'build' })
    const log = createWriteStream(this.logFile())
    const child = spawn(node, [script, '--ref', 'main'], {
      cwd: repo,
      env: { ...process.env, MAESTRO_USER_DATA_DIR: app.getPath('userData') }
    })
    this.child = child

    let step: 'build' | 'test' | 'publish' = 'build'
    let tests: TestProgress | undefined
    let testsFrom = 0
    let said = ''
    const buffered = { out: '', err: '' }
    const read = (chunk: Buffer, fromStderr = false): void => {
      log.write(chunk)
      const stream = fromStderr ? 'err' : 'out'
      buffered[stream] += chunk.toString('utf8')
      const lines = buffered[stream].split('\n')
      buffered[stream] = lines.pop() ?? ''
      for (const line of lines) {
        const running = /^Running (\d+) tests? using/.exec(line.trim())
        if (line.startsWith('$ npx playwright')) step = 'test'
        else if (running) {
          tests = { done: 0, total: Number(running[1]), leftSeconds: null }
          testsFrom = Date.now()
        } else if (tests && /^\s+[✓✘-]\s+\d+ /.test(line)) {
          // A retry reports again under a new number, so the count is capped rather than trusted.
          const done = Math.min(tests.total, tests.done + 1)
          const perTest = (Date.now() - testsFrom) / done
          tests = { done, total: tests.total, leftSeconds: Math.round((perTest * (tests.total - done)) / 1000) }
        } else if (line.startsWith('release: published')) step = 'publish'
        // The script's own explanation when it refused, which it prints to stderr.
        else if (fromStderr && line.startsWith('release: ') && !line.endsWith(' failed')) {
          said = line.slice(9).replaceAll('`', '')
        }
      }
      this.setStatus({ state: 'building', step, ...(step === 'test' && tests ? { tests } : {}) })
    }
    child.stdout?.on('data', (chunk: Buffer) => read(chunk))
    child.stderr?.on('data', (chunk: Buffer) => read(chunk, true))
    child.on('error', (err) => read(Buffer.from(`\nrelease: ${err.message}\n`), true))
    child.on('close', (code) => {
      log.end()
      this.child = null
      if (code === 0) return void this.refresh()
      const message =
        said ||
        (step === 'test' ? 'Tests failed on main. See the log.' : 'main did not build. See the log.')
      void this.ahead().then((ahead) => fail(message, ahead?.commit ?? this.aheadAt))
    })
  }

  private apply(stamp: ReleaseStamp): void {
    const options = this.options
    const releases = this.releases
    const window = options?.window()
    if (!options || !releases || !window || window.isDestroyed()) return

    if (stamp.hostProtocol !== HOST_PROTOCOL) {
      this.wanted = false
      this.setStatus({ state: 'restart', subject: stamp.subject })
      return
    }
    this.setStatus({ state: 'applying' })
    // Not under an open dialog: whatever is half-typed in it would go with the window.
    if (this.busy) return

    this.wanted = false
    ptys.stashSet(UPDATED_KEY, stamp.subject || stamp.id)
    const sameMain =
      !!this.running &&
      stamp.hashes.main === this.running.hashes.main &&
      stamp.hashes.preload === this.running.hashes.preload

    if (!sameMain) {
      console.log(`[maestro] relaunching onto release ${stamp.id}`)
      options.prepareRelaunch()
      // Under test the next instance is started by the test, which cannot follow a relaunch.
      if (process.env.MAESTRO_NO_RELAUNCH !== '1') app.relaunch()
      app.exit(0)
      return
    }

    console.log(`[maestro] reloading the window from release ${stamp.id}`)
    const previous = this.shown
    this.shown = stamp.id
    this.status = { state: 'none' }
    this.deadline = setTimeout(() => {
      this.deadline = null
      console.error(`[maestro] release ${stamp.id} did not bring up a window, going back`)
      releases.markBad(stamp.id, 'window did not come up after a live reload')
      this.shown = previous
      ptys.stashSet(UPDATED_KEY, null)
      if (!window.isDestroyed()) void window.loadFile(this.rendererOf(previous))
    }, WINDOW_DEADLINE_MS)
    void window.loadFile(join(releases.bundle(stamp.id), 'renderer', 'index.html'))
  }

  /** The page a release id serves, the running build's own for the id it started as. */
  private rendererOf(id: string): string {
    const bundle =
      id && id !== this.running?.id && this.releases ? this.releases.bundle(id) : join(here, '..')
    return join(bundle, 'renderer', 'index.html')
  }
}

export const updater = new Updater()
