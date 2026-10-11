/**
 * The terminal host: the one part of Maestro that keeps running while the rest is replaced.
 *
 * Every terminal — each Claude, console and script — is a child of this process rather than of the
 * app. Main connects over a unix socket and drives them, and when main goes away (an update
 * relaunching it, a dev rebuild, a crash) the processes carry on here. The next main reconnects,
 * and a window replays each terminal's recent output before going live again.
 *
 * Run with Electron's own binary under ELECTRON_RUN_AS_NODE, so node-pty's native build matches.
 * Deliberately small and free of Electron: a change here reaches users only on a real restart, so
 * it should rarely need one. See HOST_PROTOCOL.
 */
import { createRequire } from 'node:module'
import { createServer, connect, type Socket } from 'node:net'
import { chmodSync, unlinkSync } from 'node:fs'
import type { IPty } from 'node-pty'
import {
  HOST_PROTOCOL,
  type ClientMessage,
  type HostEntry,
  type HostMessage,
  type SpawnRequest
} from './ptyProtocol'

const socketPath = process.argv[2]
const ptyModule = process.env.MAESTRO_NODE_PTY
if (!socketPath || !ptyModule) {
  console.error('[pty-host] usage: MAESTRO_NODE_PTY=<path> pty-host <socket>')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const pty = require(ptyModule) as typeof import('node-pty')

/** Output is coalesced over this window before it is sent. */
const FLUSH_MS = 4
const FLUSH_BYTES = 64 * 1024
/** Recent output kept per terminal, for a window that attaches after it was written. */
const REPLAY_LIMIT = 2 * 1024 * 1024
const TAIL_LIMIT = 4096
/** Finished terminals kept for their output, oldest dropped first beyond this. */
const RETAINED_EXITS = 64
/**
 * How long the host waits for a main process to come back before ending every terminal. Long enough
 * to ride out a relaunch or a crash; short enough that agents do not run on forever unwatched.
 */
const ORPHAN_GRACE_MS = Number(process.env.MAESTRO_PTY_HOST_GRACE_MS) || 15 * 60 * 1000

interface Entry extends HostEntry {
  proc: IPty | null
  replay: string[]
  replayBytes: number
  pending: string[]
  pendingBytes: number
  timer: NodeJS.Timeout | null
  exitedAt: number
}

const entries = new Map<string, Entry>()
const clients = new Set<Socket>()
const stash: Record<string, unknown> = {}

function log(message: string): void {
  console.log(`${new Date().toISOString()} [pty-host] ${message}`)
}

function send(socket: Socket, message: HostMessage): void {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n')
}

function broadcast(message: HostMessage): void {
  for (const socket of clients) send(socket, message)
}

function flush(entry: Entry): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (entry.pending.length === 0) return
  const data = entry.pending.join('')
  entry.pending = []
  entry.pendingBytes = 0
  broadcast({ t: 'data', id: entry.id, data })
}

function record(entry: Entry, chunk: string): void {
  entry.tail = (entry.tail + chunk).slice(-TAIL_LIMIT)
  entry.replay.push(chunk)
  entry.replayBytes += chunk.length
  while (entry.replayBytes > REPLAY_LIMIT && entry.replay.length > 1) {
    entry.replayBytes -= entry.replay.shift()!.length
  }
  entry.pending.push(chunk)
  entry.pendingBytes += chunk.length
  if (entry.pendingBytes >= FLUSH_BYTES) flush(entry)
  else if (!entry.timer) entry.timer = setTimeout(() => flush(entry), FLUSH_MS)
}

function markExited(entry: Entry, exitCode: number, signal: number | null): void {
  entry.exited = true
  entry.exitCode = exitCode
  entry.signal = signal
  entry.exitedAt = Date.now()
  entry.proc = null
  flush(entry)
  broadcast({ t: 'exit', id: entry.id, exitCode, signal, tail: entry.tail })
  pruneExited()
  scheduleIdleCheck()
}

function pruneExited(): void {
  const exited = [...entries.values()].filter((e) => e.exited).sort((a, b) => a.exitedAt - b.exitedAt)
  for (const entry of exited.slice(0, Math.max(0, exited.length - RETAINED_EXITS))) {
    entries.delete(entry.id)
  }
}

function spawn(request: SpawnRequest): void {
  // A new process for a tab supersedes whatever finished there before it.
  for (const [id, other] of entries) {
    if (other.slot === request.slot && other.exited) entries.delete(id)
  }

  const entry: Entry = {
    id: request.id,
    slot: request.slot,
    sessionId: request.sessionId,
    kind: request.kind,
    label: request.label,
    exited: false,
    exitCode: null,
    signal: null,
    tail: '',
    exitHandled: false,
    proc: null,
    replay: [],
    replayBytes: 0,
    pending: [],
    pendingBytes: 0,
    timer: null,
    exitedAt: 0
  }
  entries.set(entry.id, entry)

  try {
    const proc = pty.spawn(request.command, request.args, {
      name: 'xterm-256color',
      cwd: request.cwd,
      cols: Math.max(request.cols, 2),
      rows: Math.max(request.rows, 2),
      env: request.env
    })
    entry.proc = proc
    proc.onData((chunk) => record(entry, chunk))
    proc.onExit(({ exitCode, signal }) => markExited(entry, exitCode, signal ?? null))
  } catch (err) {
    record(entry, `${err instanceof Error ? err.message : String(err)}\r\n`)
    markExited(entry, 1, null)
  }
}

function kill(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  flush(entry)
  entries.delete(id)
  try {
    entry.proc?.kill()
  } catch {
    // Already gone.
  }
}

function snapshot(entry: Entry): HostEntry {
  const { id, slot, sessionId, kind, label, exited, exitCode, signal, tail, exitHandled } = entry
  return { id, slot, sessionId, kind, label, exited, exitCode, signal, tail, exitHandled }
}

async function shutdown(graceMs: number): Promise<void> {
  log('shutting down')
  for (const entry of entries.values()) {
    try {
      entry.proc?.kill('SIGTERM')
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && [...entries.values()].some((e) => !e.exited)) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  for (const entry of entries.values()) {
    try {
      entry.proc?.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
  entries.clear()
}

function handle(socket: Socket, message: ClientMessage): void {
  switch (message.t) {
    case 'hello':
      send(socket, { t: 'hello', protocol: HOST_PROTOCOL, pid: process.pid })
      return
    case 'spawn':
      spawn(message)
      return
    case 'write': {
      const entry = entries.get(message.id)
      if (entry?.proc) entry.proc.write(message.data)
      return
    }
    case 'resize': {
      const entry = entries.get(message.id)
      try {
        entry?.proc?.resize(Math.max(message.cols, 2), Math.max(message.rows, 2))
      } catch {
        // Exited between the measurement and this call.
      }
      return
    }
    case 'kill':
      kill(message.id)
      scheduleIdleCheck()
      return
    case 'exit-handled': {
      const entry = entries.get(message.id)
      if (entry) entry.exitHandled = true
      return
    }
    case 'list':
      send(socket, { t: 'list', req: message.req, entries: [...entries.values()].map(snapshot) })
      return
    case 'replay': {
      const entry = entries.get(message.id)
      // Anything still being coalesced goes out first, so it is not in the replay and sent again.
      if (entry) flush(entry)
      send(socket, { t: 'replay', req: message.req, data: entry ? entry.replay.join('') : '' })
      return
    }
    case 'stash-set':
      if (message.value === undefined || message.value === null) delete stash[message.key]
      else stash[message.key] = message.value
      return
    case 'stash-get':
      send(socket, { t: 'stash', req: message.req, value: stash })
      return
    case 'shutdown':
      void shutdown(message.graceMs).then(() => {
        send(socket, { t: 'done', req: message.req })
        exit()
      })
      return
  }
}

// ── lifetime ────────────────────────────────────────────────────────────────
let orphanTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null

/** With no terminals and nobody connected there is nothing to keep, so the host leaves. */
function scheduleIdleCheck(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (clients.size === 0 && ![...entries.values()].some((e) => !e.exited)) {
      log('idle, exiting')
      exit()
    }
  }, 5000)
}

function onClientsChanged(): void {
  if (clients.size > 0) {
    if (orphanTimer) clearTimeout(orphanTimer)
    orphanTimer = null
    return
  }
  scheduleIdleCheck()
  if (orphanTimer) return
  orphanTimer = setTimeout(() => {
    if (clients.size > 0) return
    log('no client came back, ending terminals')
    void shutdown(1500).then(exit)
  }, ORPHAN_GRACE_MS)
}

let exiting = false
function exit(): void {
  if (exiting) return
  exiting = true
  try {
    unlinkSync(socketPath!)
  } catch {
    // Already gone.
  }
  process.exit(0)
}

const server = createServer((socket) => {
  socket.setEncoding('utf8')
  clients.add(socket)
  onClientsChanged()
  let buffered = ''
  socket.on('data', (chunk: string) => {
    buffered += chunk
    let at: number
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      if (!line) continue
      try {
        handle(socket, JSON.parse(line) as ClientMessage)
      } catch (err) {
        log(`bad message: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    clients.delete(socket)
    onClientsChanged()
  })
})

function listen(): void {
  server.listen(socketPath, () => {
    chmodSync(socketPath!, 0o600)
    log(`listening on ${socketPath} (pid ${process.pid})`)
    onClientsChanged()
  })
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') {
    log(`server error: ${err.message}`)
    process.exit(1)
  }
  // Either another host is serving this socket, or one died and left the file behind.
  const probe = connect(socketPath!)
  probe.on('connect', () => {
    log('another host is already running')
    probe.destroy()
    process.exit(0)
  })
  probe.on('error', () => {
    try {
      unlinkSync(socketPath!)
    } catch {
      // Raced with another host cleaning up.
    }
    listen()
  })
})

// Terminal signals aimed at the app's process group must not take the terminals with them.
process.on('SIGHUP', () => {})
process.on('SIGINT', () => {})
process.on('SIGTERM', () => void shutdown(1500).then(exit))

listen()
