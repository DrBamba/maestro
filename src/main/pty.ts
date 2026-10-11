import { app, type WebContents } from 'electron'
import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { openSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PtyKind } from '@shared/types'
import { fallbackShell, platformOf } from '@shared/platform'
import {
  HOST_PROTOCOL,
  hostSocketPath,
  type ClientMessage,
  type HostEntry,
  type HostMessage
} from './ptyProtocol'

const here = dirname(fileURLToPath(import.meta.url))

export interface SpawnOptions {
  sessionId: string
  /** The tab this terminal fills — `<sessionId>:<tab key>` — so a reloaded window can find it. */
  slot: string
  kind: PtyKind
  label: string
  cwd: string
  command: string
  args: string[]
  cols: number
  rows: number
  env?: Record<string, string>
  /** Called in the main process when the process exits, in addition to the renderer event. */
  onExit?: (exitCode: number) => void
}

/** A terminal a window picked back up: what it printed so far, and how it ended if it has. */
export interface Attached {
  id: string
  replay: string
  exit?: { exitCode: number; tail: string }
}

interface Entry extends HostEntry {
  /** Whether the current window is showing this terminal. Output is only sent for these. */
  claimed: boolean
}

function defaultShell(): string {
  return process.env.SHELL || fallbackShell(platformOf(process.platform))
}

/**
 * Every terminal in the app, as seen from main. The processes themselves live in the terminal host
 * (ptyHost.ts), which outlives this process; this keeps a mirror of them and relays between the
 * host and the window.
 */
export class PtyManager {
  private entries = new Map<string, Entry>()
  private target: WebContents | null = null
  private socket: Socket | null = null
  private outbox: string[] = []
  private exitHandlers = new Map<string, (exitCode: number) => void>()
  private recoveredExit: ((entry: HostEntry) => void) | null = null
  private requests = new Map<number, (message: HostMessage) => void>()
  private nextReq = 1
  private connecting: Promise<void> | null = null

  attach(webContents: WebContents): void {
    this.target = webContents
  }

  /**
   * What to do about a terminal that exited with nobody left to hear it — its main process was
   * replaced in the meantime, so the callback it was spawned with is gone.
   */
  onRecoveredExit(handler: (entry: HostEntry) => void): void {
    this.recoveredExit = handler
  }

  // ── connection ─────────────────────────────────────────────────────────────
  connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<void> {
    const path = hostSocketPath(app.getPath('userData'), HOST_PROTOCOL)
    let socket = await tryConnect(path)
    if (!socket) {
      startHost(path)
      const deadline = Date.now() + 10_000
      while (!socket && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        socket = await tryConnect(path)
      }
    }
    if (!socket) throw new Error(`terminal host did not start (${path})`)

    this.socket = socket
    socket.setEncoding('utf8')
    let buffered = ''
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let at: number
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        if (line) this.receive(JSON.parse(line) as HostMessage)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => this.lost(socket!))

    this.post({ t: 'hello', protocol: HOST_PROTOCOL })
    for (const line of this.outbox.splice(0)) socket.write(line)

    const listed = await this.request<{ t: 'list'; entries: HostEntry[] }>({ t: 'list', req: 0 })
    for (const entry of listed.entries) {
      if (!this.entries.has(entry.id)) this.entries.set(entry.id, { ...entry, claimed: false })
    }
    for (const entry of listed.entries) {
      if (entry.exited && !entry.exitHandled) this.handleExit(entry.id)
    }
    console.log(`[maestro] terminal host connected (${listed.entries.length} terminal(s))`)
  }

  /** The host went away, and every terminal with it. */
  private lost(socket: Socket): void {
    if (this.socket !== socket) return
    this.socket = null
    if (this.shuttingDown) return
    console.error('[maestro] terminal host disconnected')
    for (const entry of this.entries.values()) {
      if (entry.exited) continue
      entry.exited = true
      entry.exitCode = -1
      if (entry.claimed) this.send('pty:exit', { id: entry.id, exitCode: -1, signal: null, tail: entry.tail })
      this.exitHandlers.get(entry.id)?.(-1)
      this.exitHandlers.delete(entry.id)
    }
    void this.connect().catch((err) => console.error('[maestro] terminal host restart failed', err))
  }

  private post(message: ClientMessage): void {
    const line = JSON.stringify(message) + '\n'
    if (this.socket && !this.socket.destroyed) this.socket.write(line)
    else this.outbox.push(line)
  }

  private request<T>(message: Extract<ClientMessage, { req: number }>): Promise<T> {
    const req = this.nextReq++
    return new Promise<T>((resolve) => {
      this.requests.set(req, resolve as (message: HostMessage) => void)
      this.post({ ...message, req })
    })
  }

  private receive(message: HostMessage): void {
    if ('req' in message) {
      const resolve = this.requests.get(message.req)
      this.requests.delete(message.req)
      resolve?.(message)
      return
    }
    if (message.t === 'hello') {
      if (message.protocol !== HOST_PROTOCOL) {
        console.error(`[maestro] terminal host speaks protocol ${message.protocol}, expected ${HOST_PROTOCOL}`)
      }
      return
    }
    const entry = this.entries.get(message.id)
    if (!entry) return
    if (message.t === 'data') {
      entry.tail = (entry.tail + message.data).slice(-4096)
      if (entry.claimed) this.send('pty:data', { id: entry.id, data: message.data })
      return
    }
    entry.exited = true
    entry.exitCode = message.exitCode
    entry.signal = message.signal
    entry.tail = message.tail
    this.handleExit(entry.id)
  }

  private handleExit(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const exitCode = entry.exitCode ?? -1
    if (entry.claimed) {
      this.send('pty:exit', { id, exitCode, signal: entry.signal, tail: entry.tail })
    }
    const handler = this.exitHandlers.get(id)
    this.exitHandlers.delete(id)
    if (handler) handler(exitCode)
    else this.recoveredExit?.(entry)
    entry.exitHandled = true
    this.post({ t: 'exit-handled', id })
  }

  private send(channel: string, payload: unknown): void {
    if (this.target && !this.target.isDestroyed()) this.target.send(channel, payload)
  }

  // ── terminals ──────────────────────────────────────────────────────────────
  spawn(opts: SpawnOptions): { id: string } {
    const id = randomUUID()
    // Superseded, like the host does: only the newest terminal in a tab is the tab's.
    for (const [other, entry] of this.entries) {
      if (entry.slot === opts.slot && entry.exited) this.entries.delete(other)
    }
    this.entries.set(id, {
      id,
      slot: opts.slot,
      sessionId: opts.sessionId,
      kind: opts.kind,
      label: opts.label,
      exited: false,
      exitCode: null,
      signal: null,
      tail: '',
      exitHandled: false,
      claimed: true
    })
    if (opts.onExit) this.exitHandlers.set(id, opts.onExit)

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries({
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...opts.env
    })) {
      if (value !== undefined) env[key] = value
    }

    this.post({
      t: 'spawn',
      id,
      slot: opts.slot,
      sessionId: opts.sessionId,
      kind: opts.kind,
      label: opts.label,
      cwd: opts.cwd,
      command: opts.command,
      args: opts.args,
      cols: opts.cols,
      rows: opts.rows,
      env
    })
    return { id }
  }

  /**
   * Hands a tab the terminal it already had, if the host still holds one nobody is showing — the
   * window was reloaded, or main was replaced under it. Null means start a new one.
   */
  async claim(slot: string): Promise<Attached | null> {
    const candidates = [...this.entries.values()].filter((e) => e.slot === slot && !e.claimed)
    const entry = candidates.find((e) => !e.exited) ?? candidates[0]
    if (!entry) return null
    // Claimed before the await, so a second request for the same tab cannot take it too.
    entry.claimed = true
    const { data } = await this.request<{ t: 'replay'; data: string }>({ t: 'replay', req: 0, id: entry.id })
    return {
      id: entry.id,
      replay: data,
      exit: entry.exited ? { exitCode: entry.exitCode ?? -1, tail: entry.tail } : undefined
    }
  }

  /** The window was replaced: nothing is on screen until it asks for its terminals again. */
  releaseAll(): void {
    for (const entry of this.entries.values()) entry.claimed = false
  }

  /** Tabs with a terminal waiting for them. */
  heldSlots(): string[] {
    return [...new Set([...this.entries.values()].filter((e) => !e.claimed).map((e) => e.slot))]
  }

  /** A login-interactive shell in the worktree. */
  spawnShell(
    sessionId: string,
    slot: string,
    cwd: string,
    label: string,
    cols: number,
    rows: number
  ): { id: string } {
    return this.spawn({
      sessionId,
      slot,
      kind: 'shell',
      label,
      cwd,
      command: defaultShell(),
      args: ['-l'],
      cols,
      rows
    })
  }

  /**
   * Runs a command in the worktree (PLAN.md open question 4: script output lives in a terminal
   * tab, not a bespoke panel). `keepOpen` drops into an interactive shell afterwards so the
   * output of a finished script stays readable; setup scripts leave it off so we can observe
   * the exit code.
   */
  spawnScript(
    sessionId: string,
    slot: string,
    cwd: string,
    label: string,
    command: string,
    cols: number,
    rows: number,
    opts: { keepOpen?: boolean; env?: Record<string, string>; onExit?: (code: number) => void } = {}
  ): { id: string } {
    const shell = defaultShell()
    const script = opts.keepOpen ? `${command}; exec ${shell} -l -i` : command
    return this.spawn({
      sessionId,
      slot,
      kind: 'script',
      label,
      cwd,
      command: shell,
      args: ['-l', '-i', '-c', script],
      cols,
      rows,
      env: opts.env,
      onExit: opts.onExit
    })
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id)
    if (entry && !entry.exited) this.post({ t: 'write', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (entry && !entry.exited) this.post({ t: 'resize', id, cols, rows })
  }

  kill(id: string): void {
    if (!this.entries.has(id)) return
    this.entries.delete(id)
    this.post({ t: 'kill', id })
  }

  /** The session a pty belongs to, and whether it is the session's Claude. */
  ownerOf(id: string): { sessionId: string; kind: PtyKind } | null {
    const entry = this.entries.get(id)
    return entry ? { sessionId: entry.sessionId, kind: entry.kind } : null
  }

  killSession(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.kill(id)
    }
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }

  /** Sessions with a live Claude process, so shutdown can report what it is about to interrupt. */
  liveClaudeSessions(): string[] {
    const ids = new Set<string>()
    for (const entry of this.entries.values()) {
      if (entry.kind === 'claude' && !entry.exited) ids.add(entry.sessionId)
    }
    return [...ids]
  }

  // ── window state ───────────────────────────────────────────────────────────
  /** Kept by the host, so a tab layout outlives the main process as its terminals do. */
  stashSet(key: string, value: unknown): void {
    this.post({ t: 'stash-set', key, value: value ?? null })
  }

  async stashGet(): Promise<Record<string, unknown>> {
    const { value } = await this.request<{ t: 'stash'; value: Record<string, unknown> }>({
      t: 'stash-get',
      req: 0
    })
    return value
  }

  private shuttingDown = false

  /**
   * Ends every terminal and the host with them. Claude gets a moment to flush its transcript
   * before anything is forced.
   */
  async shutdown(graceMs = 1500): Promise<void> {
    if (!this.socket) return
    this.shuttingDown = true
    await Promise.race([
      this.request({ t: 'shutdown', req: 0, graceMs }),
      new Promise((resolve) => setTimeout(resolve, graceMs + 2000))
    ])
    this.entries.clear()
  }

  /** Lets go of the host without ending anything, for a relaunch that will pick it all back up. */
  detach(): void {
    this.shuttingDown = true
    this.socket?.end()
  }
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', () => resolve(null))
  })
}

/** Starts a host in its own process group, so it survives this process and its signals. */
function startHost(socketPath: string): void {
  const userData = app.getPath('userData')
  // Resolved from the app, not from this file: a release runs its main from a directory with no
  // node_modules of its own.
  const nodePty = createRequire(join(app.getAppPath(), 'package.json')).resolve('node-pty')
  const log = openSync(join(userData, 'pty-host.log'), 'a')
  const env: Record<string, string | undefined> = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MAESTRO_NODE_PTY: nodePty
  }
  const child = spawnProcess(process.execPath, [join(here, 'ptyHost.js'), socketPath], {
    detached: true,
    stdio: ['ignore', log, log],
    env
  })
  child.unref()
  closeSync(log)
}

export const ptys = new PtyManager()
