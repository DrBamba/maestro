import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { IPty } from 'node-pty'
import type { PtyKind } from '@shared/types'
import { fallbackShell, platformOf } from '@shared/platform'

// node-pty is a native CJS addon; createRequire keeps it loadable from an ESM main process.
const require = createRequire(import.meta.url)
const pty = require('node-pty') as typeof import('node-pty')

/** Output is coalesced over this window before crossing the IPC boundary. */
const FLUSH_MS = 4
/** …or immediately once this much has piled up, so bulk output stays responsive. */
const FLUSH_BYTES = 64 * 1024

export interface SpawnOptions {
  sessionId: string
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

/** How much trailing output to retain, so a process's exit can be explained. */
const TAIL_LIMIT = 4096

interface Entry {
  id: string
  sessionId: string
  kind: PtyKind
  label: string
  proc: IPty
  buffer: string[]
  bytes: number
  timer: NodeJS.Timeout | null
  exited: boolean
  /**
   * Rolling tail of what the process printed. A failed `claude --resume` explains itself on
   * stdout — "currently running as a background agent" — and that is far more reliable than
   * guessing liveness from timestamps, so the exit event carries it.
   */
  tail: string
}

function defaultShell(): string {
  return process.env.SHELL || fallbackShell(platformOf(process.platform))
}

/**
 * Owns every PTY in the app. Output is batched per terminal and pushed to the renderer;
 * xterm.js writes it straight into its own buffer.
 */
export class PtyManager {
  private entries = new Map<string, Entry>()
  private target: WebContents | null = null

  attach(webContents: WebContents): void {
    this.target = webContents
  }

  private send(channel: string, payload: unknown): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(channel, payload)
    }
  }

  private flush(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.buffer.length === 0) return
    const data = entry.buffer.join('')
    entry.buffer = []
    entry.bytes = 0
    this.send('pty:data', { id: entry.id, data })
  }

  private queue(entry: Entry, chunk: string): void {
    entry.tail = (entry.tail + chunk).slice(-TAIL_LIMIT)
    entry.buffer.push(chunk)
    entry.bytes += chunk.length
    if (entry.bytes >= FLUSH_BYTES) {
      this.flush(entry)
      return
    }
    if (!entry.timer) {
      entry.timer = setTimeout(() => this.flush(entry), FLUSH_MS)
    }
  }

  spawn(opts: SpawnOptions): { id: string } {
    const proc = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      env: {
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...opts.env
      }
    })

    const entry: Entry = {
      id: randomUUID(),
      sessionId: opts.sessionId,
      kind: opts.kind,
      label: opts.label,
      proc,
      tail: '',
      buffer: [],
      bytes: 0,
      timer: null,
      exited: false
    }
    this.entries.set(entry.id, entry)

    proc.onData((chunk) => this.queue(entry, chunk))
    proc.onExit(({ exitCode, signal }) => {
      entry.exited = true
      this.flush(entry)
      this.send('pty:exit', {
        id: entry.id,
        exitCode,
        signal: signal ?? null,
        tail: entry.tail
      })
      opts.onExit?.(exitCode)
    })

    return { id: entry.id }
  }

  /** A login-interactive shell in the worktree. */
  spawnShell(sessionId: string, cwd: string, label: string, cols: number, rows: number): { id: string } {
    return this.spawn({
      sessionId,
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
    if (entry && !entry.exited) entry.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (!entry || entry.exited) return
    try {
      entry.proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      // The process can exit between the renderer measuring and this call landing.
    }
  }

  kill(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.flush(entry)
    if (!entry.exited) {
      try {
        entry.proc.kill()
      } catch {
        // Already gone.
      }
    }
    this.entries.delete(id)
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

  /**
   * Asks every process to exit, then waits briefly before forcing it. An abrupt kill can cut
   * Claude off mid-write, so it gets a moment to flush its transcript.
   */
  async shutdown(graceMs = 1500): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.exited) continue
      this.flush(entry)
      try {
        entry.proc.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }

    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if ([...this.entries.values()].every((entry) => entry.exited)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.killAll()
  }
}

export const ptys = new PtyManager()
