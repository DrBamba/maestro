import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeUsage, UsageWindow } from '@shared/types'

const exec = promisify(execFile)

/**
 * The plan limits Claude Code's `/usage` shows — the five-hour session and the weekly caps — read
 * from the same endpoint it reads them from, with the sign-in Claude Code already holds.
 *
 * The token is only ever borrowed. Claude Code owns the sign-in and refreshes it on its own runs;
 * refreshing here would rotate the refresh token out from under it. So an expired token is
 * reported, and the next poll after any `claude` run picks up the fresh one.
 *
 * `MAESTRO_CLAUDE_USAGE_URL` points the request somewhere else, which is how the e2e suite serves
 * a fixture. `CLAUDE_CONFIG_DIR` moves the credentials the same way it moves them for Claude Code.
 */
const USAGE_URL = process.env.MAESTRO_CLAUDE_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage'
/** Several windows poll; the endpoint is asked at most this often. */
const FRESH_MS = 60_000

interface Credentials {
  accessToken: string
  expiresAt: number | null
  plan: string | null
}

function configDir(): string | null {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || null
}

/** Claude Code suffixes the keychain entry with a hash of a non-default config directory. */
function keychainService(): string {
  const dir = configDir()
  if (!dir) return 'Claude Code-credentials'
  return `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`
}

function parseCredentials(raw: string): Credentials | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth
    if (!oauth || typeof oauth.accessToken !== 'string') return null
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
      plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null
    }
  } catch {
    return null
  }
}

/** The macOS keychain first, where Claude Code keeps it there; the credentials file otherwise. */
async function readCredentials(): Promise<Credentials | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', keychainService(), '-w'])
      const found = parseCredentials(stdout.trim())
      if (found) return found
    } catch {
      // No keychain entry: fall through to the file.
    }
  }
  try {
    const file = join(configDir() ?? join(homedir(), '.claude'), '.credentials.json')
    return parseCredentials(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

interface RawLimit {
  kind?: string
  percent?: number
  resets_at?: string | null
}
interface RawWindow {
  utilization?: number | null
  resets_at?: string | null
}
interface RawUsage {
  limits?: RawLimit[]
  five_hour?: RawWindow | null
  seven_day?: RawWindow | null
  seven_day_opus?: RawWindow | null
  seven_day_sonnet?: RawWindow | null
  /** Pay-as-you-go credits past the plan limits, in minor units of `currency`. */
  spend?: {
    enabled?: boolean
    used?: Money | null
    limit?: Money | null
    percent?: number | null
  } | null
}
interface Money {
  amount_minor?: number
  currency?: string
  exponent?: number
}

function money(m: Money | null | undefined): string | null {
  if (!m || typeof m.amount_minor !== 'number') return null
  const value = m.amount_minor / 10 ** (m.exponent ?? 2)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency || 'USD' }).format(value)
  } catch {
    return value.toFixed(2)
  }
}

const LABELS: Record<string, string> = {
  session: 'Session',
  weekly_all: 'Weekly',
  weekly_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet'
}

/** `weekly_fancy_model` → "Weekly · Fancy model", for a limit added after this was written. */
function labelFor(kind: string): string {
  if (LABELS[kind]) return LABELS[kind]
  const [head, ...rest] = kind.split('_')
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  return rest.length ? `${cap(head)} · ${cap(rest.join(' '))}` : cap(head)
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** Prefers the `limits` list, which names each window; the older per-window fields otherwise. */
export function parseUsage(raw: RawUsage): UsageWindow[] {
  if (Array.isArray(raw.limits) && raw.limits.length) {
    return raw.limits
      .filter((l): l is RawLimit & { kind: string; percent: number } =>
        typeof l.kind === 'string' && typeof l.percent === 'number'
      )
      .map((l) => ({ label: labelFor(l.kind), percent: clamp(l.percent), resetsAt: l.resets_at ?? null }))
  }
  const legacy: [string, RawWindow | null | undefined][] = [
    ['Session', raw.five_hour],
    ['Weekly', raw.seven_day],
    ['Weekly · Opus', raw.seven_day_opus],
    ['Weekly · Sonnet', raw.seven_day_sonnet]
  ]
  return legacy
    .filter((entry): entry is [string, RawWindow & { utilization: number }] =>
      typeof entry[1]?.utilization === 'number'
    )
    .map(([label, w]) => ({ label, percent: clamp(w.utilization), resetsAt: w.resets_at ?? null }))
}

let cached: ClaudeUsage | null = null
let inflight: Promise<ClaudeUsage> | null = null

async function load(): Promise<ClaudeUsage> {
  const creds = await readCredentials()
  if (!creds) return { ok: false, error: 'Not signed in to Claude. Run `claude` and log in.', at: Date.now() }
  if (creds.expiresAt !== null && creds.expiresAt < Date.now()) {
    return { ok: false, error: 'Claude’s sign-in has expired. Run `claude` to refresh it.', at: Date.now() }
  }
  let res: Response
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'maestro'
      },
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    return { ok: false, error: 'Couldn’t reach Anthropic. Check your connection.', at: Date.now() }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Claude’s sign-in was refused. Run `claude` and log in again.', at: Date.now() }
  }
  if (!res.ok) return { ok: false, error: `Usage is unavailable right now (HTTP ${res.status}).`, at: Date.now() }
  let raw: RawUsage
  try {
    raw = (await res.json()) as RawUsage
  } catch {
    return { ok: false, error: 'Usage came back unreadable.', at: Date.now() }
  }
  const spend = raw.spend
  const used = spend?.enabled ? money(spend.used) : null
  return {
    ok: true,
    at: Date.now(),
    plan: creds.plan,
    windows: parseUsage(raw),
    extra: used
      ? {
          used,
          limit: money(spend?.limit),
          percent: typeof spend?.percent === 'number' ? clamp(spend.percent) : null
        }
      : null
  }
}

/** The latest reading, from cache when it is under a minute old unless `force`. */
export async function claudeUsage(force = false): Promise<ClaudeUsage> {
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return cached
  inflight ??= load().then((result) => {
    // A failed refresh keeps showing the last good numbers; the error rides along.
    cached = !result.ok && cached?.ok ? { ...cached, stale: result.error } : result
    inflight = null
    return cached
  })
  return inflight
}
