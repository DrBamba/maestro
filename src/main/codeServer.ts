import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import type { CodeServerInfo } from '@shared/types'
import { likelyToolDirs, platformOf } from '@shared/platform'
import { resolveBinary } from './shellEnv'
import { THEMES, type ThemeName } from '@shared/theme'
import { resolvedTheme } from './theme'

const exec = promisify(execFile)

/**
 * PLAN.md §7: one shared code-server for the whole app, with each editor tab pointing at a
 * different worktree via ?folder= — rather than a server per session, which would multiply
 * memory by the number of open sessions.
 */

/**
 * Extensions the embed already has the first time an editor tab opens, rather than the reader
 * meeting a Python file with nothing but the built-in grammar behind it and having to go find
 * an extension themselves inside a workbench we deliberately stripped.
 *
 * - Git Graph is the commit graph PLAN.md open question 7 asks for — on Open VSX, and light.
 * - `ms-python.python` is an extension pack, so the CLI brings the debugger and the environment
 *   picker with it — including the interpreter discovery every Python tool here depends on.
 * - basedpyright is the language server. Pylance, the one most people mean, is proprietary and
 *   cannot be installed outside Microsoft's own builds, which leaves the pack falling back to the
 *   jedi-language-server it bundles. Jedi navigates, but infers nothing from types; basedpyright
 *   is Pyright, the engine the rest of the Open VSX world uses, and it reads a typed monorepo
 *   properly. Its unresolved-import diagnostics are the honest signal a worktree was never synced.
 */
const EXTENSIONS = ['mhutchie.git-graph', 'ms-python.python', 'detachhead.basedpyright']

/**
 * Stderr that is normal and says nothing about health, so a startup failure is never blamed on it.
 *
 * The web workbench asks for vsda on every load — Microsoft's proprietary connection signer, absent
 * from open-source builds — and the static file server logs the miss. Both ends already handle it:
 * the server finds no `node_modules/vsda` and signs nothing, the client's `sign` swallows the load
 * failure and returns the message as-is, and `validate` accepts an unsigned message. Being the last
 * thing printed on a healthy start, it would otherwise be the sentence a later failure inherited.
 */
const BENIGN_STDERR = /^File not found:.*vsda/

/**
 * The embed runs in a user-data-dir we own, so it comes up already themed and stripped on first
 * launch rather than showing a stock workbench with a full sidebar for a beat.
 *
 * Everything here is theme-independent; the colours are added by {@link themedSettings}.
 */
const EMBED_SETTINGS = {
  // The left side bar is the shell's only file-tree and git surface now that the Changes and
  // Git panels are gone, so the activity bar stays — moved to the top of the side bar, which
  // keeps view switching without spending a full vertical strip on it.
  'workbench.activityBar.location': 'top',
  // Code 1.112 defaults this to "visibleInWorkspace", which is what makes the Chat panel open
  // itself whenever a folder loads. We never want a second side bar in the embed.
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  // Chrome the shell already provides, or that the editor does not need.
  'workbench.statusBar.visible': false,
  'workbench.layoutControl.enabled': false,
  /*
   * Editor title actions stay. Hiding them looked like removing chrome, but that row is where
   * VS Code puts the per-file actions with no other entry point in a stripped workbench: the
   * diff editor's "Open File", and markdown's "Open Preview". Hiding it removed those, so a diff
   * was a dead end and a markdown file could only ever be read as source.
   */
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'window.menuBarVisibility': 'hidden',
  'editor.minimap.enabled': false,
  /*
   * No `python.defaultInterpreterPath` here, deliberately. Naming `${workspaceFolder}/.venv` looked
   * free — the workspace venv is what a monorepo's sibling packages resolve through, and we hide
   * the status bar the picker lives in. But a language server is launched *by* the selected
   * interpreter, so in a worktree with no venv yet the setting hands the extension a python that
   * does not exist and no server starts at all: no go-to-definition anywhere, not just across
   * packages. Discovery finds a workspace `.venv` unaided, and finds a real python when there is
   * none — but it chooses once, when the extension activates, so a venv created later is not seen
   * until the next start.
   */
  /*
   * The strictness a reader gets in a plain VS Code, no more. There, Python means Pylance, whose
   * `typeCheckingMode` default is "off": no type checking at all, only the checks that read like
   * syntax errors — an import that does not resolve, a name that was never bound. basedpyright
   * instead defaults to "recommended", every rule it has, and even "standard" — Pyright's default,
   * what we shipped first — is a full type checker, so an unfamiliar file arrived pre-painted with
   * errors about code that runs fine.
   *
   * "off" alone would undershoot: basedpyright takes it literally and zeroes every rule, including
   * the unresolved import that is the honest signal a worktree was never synced. So the overrides
   * put back Pyright's own "off" set — name and import resolution, nothing that needs a type.
   */
  'basedpyright.analysis.typeCheckingMode': 'off',
  'basedpyright.analysis.diagnosticSeverityOverrides': {
    reportMissingImports: 'warning',
    reportMissingModuleSource: 'warning',
    reportUndefinedVariable: 'warning',
    reportUnboundVariable: 'warning',
    reportPossiblyUnboundVariable: 'warning',
    reportInvalidStringEscapeSequence: 'warning',
    reportAssertAlwaysTrue: 'warning',
    reportUnsupportedDunderAll: 'warning'
  },
  'basedpyright.analysis.inlayHints.variableTypes': false,
  'basedpyright.analysis.inlayHints.callArgumentNames': false,
  'basedpyright.analysis.inlayHints.functionReturnTypes': false,
  'basedpyright.analysis.inlayHints.genericTypes': false,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none'
} as const

/**
 * Where code-server ends up when it is not on PATH. The last two are the Linux packages: the
 * install script drops a launcher in ~/.local/bin, while the .deb and the distro packages put the
 * real binary under /usr/lib and only sometimes link it into /usr/bin.
 */
function candidatePaths(): string[] {
  return [
    ...likelyToolDirs(platformOf(process.platform), homedir()).map((dir) =>
      join(dir, 'code-server')
    ),
    '/usr/lib/code-server/bin/code-server',
    '/snap/bin/code-server'
  ]
}

/** Told to the user verbatim when the binary is missing, so it must name a command they can run. */
function installHint(): string {
  return platformOf(process.platform) === 'mac'
    ? 'Run `brew install code-server` (or the installer at code-server.dev), then reopen this tab.'
    : 'Run the installer at code-server.dev — `curl -fsSL https://code-server.dev/install.sh | sh` — then reopen this tab.'
}

/**
 * The workbench painted in the shell's own tokens — the theming seam PLAN.md §7 flags as the one
 * to actively manage. Every value comes from the shared palette, so the embed and the shell cannot
 * drift apart or land on different grounds.
 *
 * A stock VS Code theme is still named underneath. colorCustomizations only cover the chrome named
 * here; syntax highlighting comes from the theme's token colours, and those have to be written for
 * the ground they sit on — dark tokens on paper are a wash of near-black.
 */
function themedSettings(theme: ThemeName): Record<string, unknown> {
  const t = THEMES[theme]
  return {
    ...EMBED_SETTINGS,
    'workbench.colorTheme': theme === 'dark' ? 'Default Dark Modern' : 'Default Light Modern',
    'workbench.colorCustomizations': {
      'editor.background': t.embed,
      'editor.foreground': t.text,
      'editorGutter.background': t.embed,
      'editorLineNumber.foreground': t.textFaint,
      'editorLineNumber.activeForeground': t.textMuted,
      'editorCursor.foreground': t.accent,
      'editor.selectionBackground': t.accentSelection,
      'editor.lineHighlightBackground': t.embedLift,
      'editorWidget.background': t.overlay,
      'editorWidget.border': t.lineStrong,
      'editorGroupHeader.tabsBackground': t.chrome,
      'editorGroupHeader.noTabsBackground': t.chrome,
      'editorGroup.border': t.line,
      'tab.activeBackground': t.embed,
      'tab.inactiveBackground': t.chrome,
      'tab.activeForeground': t.text,
      'tab.inactiveForeground': t.textMuted,
      'tab.activeBorderTop': t.accent,
      'tab.border': t.line,
      'sideBar.background': t.panel,
      'sideBar.foreground': t.textBright,
      'sideBar.border': t.line,
      'sideBarSectionHeader.background': t.panel,
      'panel.background': t.embed,
      'panel.border': t.line,
      'titleBar.activeBackground': t.chrome,
      'titleBar.activeForeground': t.textMuted,
      'quickInput.background': t.overlay,
      'list.activeSelectionBackground': t.accentList,
      'list.hoverBackground': t.listHover,
      focusBorder: t.accent,
      // The trailing pair of hex digits is alpha — a slider and a diff tint are both washes.
      'scrollbarSlider.background': `${t.lineStrong}80`,
      'diffEditor.insertedTextBackground': `${t.diffAdd}22`,
      'diffEditor.removedTextBackground': `${t.diffDel}22`
    }
  }
}

/**
 * The environment to run code-server in, with the outer editor's fingerprints wiped off.
 *
 * A VS Code integrated terminal injects VSCODE_* into every shell it opens, and a `npm run dev`
 * started from one passes them down to us and then to code-server. VSCODE_IPC_HOOK_CLI is the one
 * that bites: the CLI reads it as "there is a VS Code instance to talk to", tries to forward the
 * invocation to that instance rather than starting a server, and exits 1 with "Please specify at
 * least one file or folder" — because we passed no path, having asked for a server. Which editor
 * Maestro happens to be launched from must not change what the embed is.
 */
function serverEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key]
  // Would make a node-based binary re-exec itself as plain node.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function findBinary(): Promise<string | null> {
  // PATH is scanned in-process rather than by shelling out to `which`, which is one less binary to
  // assume exists — Debian has been trying to retire it, and a minimal Ubuntu image may not have it.
  const onPath = resolveBinary('code-server')
  if (onPath) return onPath
  return candidatePaths().find((p) => existsSync(p)) ?? null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitUntilReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(port)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

class CodeServer {
  private proc: ChildProcess | null = null
  private port: number | null = null
  private binary: string | null = null
  private starting: Promise<CodeServerInfo> | null = null
  private reason = ''

  /** Idempotent — concurrent callers share one startup. */
  async ensure(): Promise<CodeServerInfo> {
    /*
     * A startup already in flight is the answer, and joining it must never disturb it. This has to
     * be asked before the liveness probe below: `start` publishes the port as soon as it spawns,
     * seconds before the server answers, so to a second caller a healthy starting server looks
     * dead — and the restart it would then trigger kills the very process the first caller is
     * waiting on. Both then wait out the timeout and report a server that never became ready.
     */
    if (this.starting) return this.starting

    /*
     * Verified reachable, not merely "we spawned it". The process can be killed from outside — a
     * stray pkill, a crash, a machine sleeping — and a stale port left the editor showing a dead
     * webview with no way back. Re-probing means the next visit to the Editor tab respawns it.
     */
    if (this.port && this.proc && !this.proc.killed && (await probe(this.port))) {
      return { available: true, url: this.baseUrl(), reason: '' }
    }

    // Asked again because the probe yields: another caller may have taken the restart in the gap.
    if (this.starting) return this.starting

    if (this.port || this.proc) this.stop()
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private async start(): Promise<CodeServerInfo> {
    this.binary = await findBinary()
    if (!this.binary) {
      this.reason = `code-server is not installed. ${installHint()}`
      return { available: false, url: null, reason: this.reason }
    }

    /*
     * Before the server, never alongside it. The extension host scans the extensions directory
     * once, about two seconds after the server starts, and lives as long as the connection — days,
     * here, since the app holds one server open for its whole run. An install still writing when
     * that scan happens is an extension the workbench never learns about: it sat correctly on
     * disk while the editor behaved as though it had never been installed, which is exactly how
     * Python ended up present and yet silent. Paying the download before the spawn costs the one
     * launch that has to do it a few seconds, and settles the directory for every scan after.
     *
     * Settings are written after it, because which language server to leave live is a question
     * only answerable once the install has had its say.
     */
    await this.installExtensions()
    const userDataDir = await this.writeEmbedSettings()

    const port = await freePort()
    const proc = spawn(
      this.binary,
      [
        '--auth',
        'none',
        '--bind-addr',
        `127.0.0.1:${port}`,
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        this.extensionsDir(),
        '--disable-telemetry',
        '--disable-update-check',
        '--disable-workspace-trust',
        '--disable-getting-started-override'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: false, env: serverEnv() }
    )

    /*
     * Kept, not just logged. When the server refuses to start it says why on stderr and exits, and
     * that sentence is the whole diagnosis — but it was only ever printed to a console the person
     * looking at the dead tab does not have. It belongs in what the tab says.
     */
    let lastError = ''
    let exited: number | null = null
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      const line = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !BENIGN_STDERR.test(l))
        .at(-1)
      if (line) lastError = line
      // The console still gets everything; only the sentence shown to the reader is filtered.
      console.error('[code-server]', text)
    })
    proc.on('exit', (code) => {
      console.log('[code-server] exited', code)
      exited = code ?? 0
      if (this.proc === proc) {
        this.proc = null
        this.port = null
      }
    })

    this.proc = proc
    this.port = port

    const ready = await waitUntilReady(port, 20_000)
    if (!ready) {
      const detail = lastError.replace(/^\[[^\]]*\]\s*(error\s*)?/, '')
      this.reason =
        exited !== null
          ? `code-server exited (${exited})${detail ? `: ${detail}` : ''}`
          : `code-server did not become ready in time.${detail ? ` Last error: ${detail}` : ''}`
      this.stop()
      return { available: false, url: null, reason: this.reason }
    }

    return { available: true, url: this.baseUrl(), reason: '' }
  }

  /**
   * Seeds the embed's user settings before the server starts, so the very first paint is
   * already dark and stripped. Rewritten on every start so shell theme changes propagate.
   *
   * Exactly one Python language server is left live. Both are real: basedpyright brings its own,
   * and the Python pack falls back to its bundled Jedi whenever Pylance is missing, which on Open
   * VSX is always. Left alone they would both answer and every hover and completion list would
   * come back doubled. basedpyright wins where it installed; where it did not — offline, or a
   * marketplace that refused — writing nothing leaves Jedi in place rather than no server at all.
   */
  private async writeEmbedSettings(): Promise<string> {
    const dir = this.dataDir()
    const userDir = join(dir, 'User')
    await mkdir(userDir, { recursive: true })
    const installed = await this.installedExtensions()
    const base = themedSettings(resolvedTheme())
    const settings = installed.has('detachhead.basedpyright')
      ? { ...base, 'python.languageServer': 'None' }
      : base
    await writeFile(join(userDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
    return dir
  }

  /**
   * Puts the theme on disk, where the next workbench load will read it.
   *
   * That is all this does, deliberately. A settings file changed under a *running* workbench is
   * not picked up — measured, not assumed: after switching to light, the embed sat on the dark
   * customizations with `vs-dark` still on its workbench element for fifteen seconds and counting.
   * So the renderer reloads the webview once this has returned, which is why the write must finish
   * before anything tells the renderer the theme has changed.
   *
   * Best-effort: a server that is not running has nothing to repaint, and the file is still
   * correct for whenever it does start.
   */
  async applyTheme(): Promise<void> {
    try {
      await this.writeEmbedSettings()
    } catch (err) {
      console.error('[code-server] could not write the theme', err)
    }
  }

  private dataDir(): string {
    return join(app.getPath('userData'), 'code-server')
  }

  private extensionsDir(): string {
    return join(this.dataDir(), 'extensions')
  }

  /**
   * What is already unpacked in our extensions directory, lowercased — VS Code's own manifest of
   * it. An unreadable or absent manifest reads as an empty set, which asks for the install and
   * lets the CLI be the judge; it is a no-op for anything already there.
   */
  private async installedExtensions(): Promise<Set<string>> {
    try {
      const raw = await readFile(join(this.extensionsDir(), 'extensions.json'), 'utf8')
      const entries = JSON.parse(raw) as Array<{ identifier?: { id?: string } }>
      const ids = entries.map((e) => e.identifier?.id?.toLowerCase()).filter((id) => !!id)
      return new Set(ids as string[])
    } catch {
      return new Set()
    }
  }

  /**
   * Best-effort: an extension is a nice-to-have, never a startup blocker.
   *
   * Only what is missing is asked for, so the usual launch spawns no CLI at all — otherwise every
   * start would pay a process and a marketplace round trip to be told what it already knows.
   */
  private async installExtensions(): Promise<void> {
    if (!this.binary) return
    const installed = await this.installedExtensions()
    const missing = EXTENSIONS.filter((id) => !installed.has(id.toLowerCase()))
    if (missing.length > 0) {
      await this.runCli(missing.flatMap((id) => ['--install-extension', id]))
    }
  }

  private async runCli(args: string[]): Promise<void> {
    if (!this.binary) return
    try {
      await exec(
        this.binary,
        ['--user-data-dir', this.dataDir(), '--extensions-dir', this.extensionsDir(), ...args],
        // Same reason as the server: a forwarded CLI would act on the outer editor, not ours.
        // The timeout is also the longest the first-ever editor open can be held waiting on a
        // slow marketplace — after it, the tab opens without them and the next start tries again.
        { timeout: 60_000, env: serverEnv() }
      )
    } catch (err) {
      // Marketplace unreachable, or a pack member Open VSX does not carry. The editor still opens.
      console.error('[code-server] extension command failed:', args.join(' '), err)
    }
  }

  /** URL for a worktree folder, or null when the server is not up. */
  folderUrl(worktreePath: string): string | null {
    if (!this.port) return null
    return `${this.baseUrl()}/?folder=${encodeURIComponent(worktreePath)}`
  }

  info(): CodeServerInfo {
    if (this.port) return { available: true, url: this.baseUrl(), reason: '' }
    return { available: false, url: null, reason: this.reason }
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill()
      } catch {
        // Already gone.
      }
    }
    this.proc = null
    this.port = null
  }
}

export const codeServer = new CodeServer()
