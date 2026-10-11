import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtyKind } from '@shared/types'

/**
 * The wire between Maestro's main process and the terminal host — newline-delimited JSON over a
 * unix socket.
 *
 * Bump this only when an older host could not serve a newer main. A running host outlives the main
 * process that started it, so a release that changes this cannot be applied live: the terminals
 * belong to the old host, and replacing it would kill every agent in them.
 */
export const HOST_PROTOCOL = 1

/**
 * One socket per data directory, so a dev instance and the installed app never share terminals.
 *
 * In the temp directory rather than beside the data, because a unix socket path is capped at 104
 * bytes on macOS and `~/Library/Application Support/…` inside a test's temp profile runs past it.
 * Versioned, so a host speaking an older protocol is never handed a main it cannot serve.
 */
export function hostSocketPath(userData: string, protocol: number): string {
  const tag = createHash('sha256').update(userData).digest('hex').slice(0, 12)
  return join(tmpdir(), `maestro-pty-${tag}-v${protocol}.sock`)
}

export interface HostEntry {
  id: string
  /** Which tab this terminal belongs to, so a reloaded window can find it again. */
  slot: string
  sessionId: string
  kind: PtyKind
  label: string
  exited: boolean
  exitCode: number | null
  signal: number | null
  tail: string
  /** Whether a main process has already acted on the exit. */
  exitHandled: boolean
}

export interface SpawnRequest {
  id: string
  slot: string
  sessionId: string
  kind: PtyKind
  label: string
  cwd: string
  command: string
  args: string[]
  cols: number
  rows: number
  /** The complete environment. The host adds nothing of its own. */
  env: Record<string, string>
}

export type ClientMessage =
  | { t: 'hello'; protocol: number }
  | ({ t: 'spawn' } & SpawnRequest)
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** Kills the process if it is running, and forgets the terminal either way. */
  | { t: 'kill'; id: string }
  | { t: 'exit-handled'; id: string }
  | { t: 'list'; req: number }
  | { t: 'replay'; req: number; id: string }
  | { t: 'stash-set'; key: string; value: unknown }
  | { t: 'stash-get'; req: number }
  /** Ends every terminal and the host with them — what quitting Maestro means. */
  | { t: 'shutdown'; req: number; graceMs: number }

export type HostMessage =
  | { t: 'hello'; protocol: number; pid: number }
  | { t: 'data'; id: string; data: string }
  | { t: 'exit'; id: string; exitCode: number; signal: number | null; tail: string }
  | { t: 'list'; req: number; entries: HostEntry[] }
  | { t: 'replay'; req: number; data: string }
  | { t: 'stash'; req: number; value: Record<string, unknown> }
  | { t: 'done'; req: number }
