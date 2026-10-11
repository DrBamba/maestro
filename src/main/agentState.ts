import { app } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { AgentState, AgentStatus } from '@shared/types'

/**
 * Resolves PLAN.md open question 1.
 *
 * We render a raw terminal, so the app cannot infer what Claude is doing from its output
 * without brittle screen-scraping. Instead each worktree gets Claude Code hooks that append
 * one word to a per-session file whenever the agent changes phase, and the app watches those
 * files. Hooks are a documented, stable contract — unlike ANSI output — so this keeps working
 * as Claude Code's UI evolves, which is the whole point of the raw-terminal bet.
 */

/** Env var the hooks read; set when the Claude PTY is spawned. */
export const STATE_FILE_ENV = 'MAESTRO_STATE_FILE'

const TRUNCATE_AT = 64 * 1024

/**
 * The events that mean one thing and need no payload read to know it.
 *
 * `PostToolUse` is the heartbeat. Nothing fires when the user answers a permission prompt, so
 * without it a session that was granted permission and went back to work kept the amber "needs
 * input" dot until its turn ended — the light stopped moving while Claude did not.
 */
const EVENT_STATE: Record<string, AgentState> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  Stop: 'done'
}

/**
 * The agent leaving, which is not a state.
 *
 * SessionEnd used to write "idle" like SessionStart, so typing /exit on a finished session wiped
 * the finish — the same reply, unread, showed as a finish or as nothing depending on whether you
 * had closed the terminal. Leaving clears what was in flight and nothing else.
 */
const SESSION_ENDED = 'ended'

/**
 * Sub-agent brackets. Not states: a sub-agent runs *inside* whatever the main agent is doing, so
 * these nest around the lifecycle words rather than replacing them, and only the pairing tells us
 * that a Stop meant "handed off" rather than "finished".
 */
const SUBAGENT_OPEN = 'subagent+'
const SUBAGENT_CLOSE = 'subagent-'

/**
 * The turn ending in an API error, which no `Stop` ever reports: Claude Code fires `StopFailure`
 * instead, and a session whose turn died on a rate limit used to be indistinguishable from one
 * that answered — same "done" dot, same chime, nothing to say the reply never came.
 *
 * Carries the kind — `rate_limit`, `authentication_failed`, `overloaded` — because a limit that
 * clears itself in a minute and a login that has to be redone are not the same news.
 */
const TURN_FAILED = 'error'

/** Long enough for any real agent name, short enough that a mangled line cannot fill the sidebar. */
const MAX_LABEL = 40

/** Stands in for an id the payload did not carry, so the name is still the second field. */
const NO_ID = '-'

function stateDir(): string {
  return join(app.getPath('userData'), 'agent-state')
}

export function stateFileFor(sessionId: string): string {
  return join(stateDir(), `${sessionId}.state`)
}

function wordCommand(word: string): string {
  // Guarded so a hook firing outside Maestro is a silent no-op, and always exits 0 so it
  // can never block the agent.
  return `[ -n "$${STATE_FILE_ENV}" ] && printf '%s\\n' '${word}' >> "$${STATE_FILE_ENV}"; exit 0`
}

/**
 * Slurps the hook's JSON payload into a variable, once.
 *
 * Once because stdin is a stream: a second reader gets an empty string, which is how a hook that
 * wanted two fields out of the same payload quietly ended up with one. Only when stdin is a pipe,
 * because a hook left waiting on a terminal would hold the agent up — the same reason every one
 * of these ends in `exit 0`.
 */
function readPayload(variable: string): string {
  return `${variable}=; [ -t 0 ] || ${variable}=$(tr -d '\\n')`
}

/** Pulls one string field out of a slurped payload; absent leaves the variable empty. */
function payloadField(payload: string, field: string, variable: string): string {
  const pattern = `s/.*"${field}"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p`
  return `${variable}=$(printf '%s' "$${payload}" | sed -n '${pattern}')`
}

/**
 * `SubagentStart` carries the agent's name, and that name is the point: "a sub-agent is running"
 * is a much weaker thing to show than "code-review is running".
 *
 * Its id goes down too, because Claude runs sub-agents in parallel and they finish in whatever
 * order they finish in. Matching each stop to the agent that sent it is the difference between
 * naming the one still running and naming whichever one happened to start last.
 */
function subagentOpenCommand(): string {
  return (
    `[ -n "$${STATE_FILE_ENV}" ] || exit 0; ` +
    `${readPayload('payload')}; ` +
    `${payloadField('payload', 'agent_id', 'id')}; ` +
    `${payloadField('payload', 'agent_type', 'name')}; ` +
    `printf '%s %s %s\\n' '${SUBAGENT_OPEN}' "$id" "$name" >> "$${STATE_FILE_ENV}"; exit 0`
  )
}

function subagentCloseCommand(): string {
  return (
    `[ -n "$${STATE_FILE_ENV}" ] || exit 0; ` +
    `${readPayload('payload')}; ` +
    `${payloadField('payload', 'agent_id', 'id')}; ` +
    `printf '%s %s\\n' '${SUBAGENT_CLOSE}' "$id" >> "$${STATE_FILE_ENV}"; exit 0`
  )
}

/**
 * `Notification` is not one event, and treating it as one is why these dots misreported.
 *
 * Its payload names the kind, and only some kinds are the user being asked something. The rest —
 * the 60-second "still waiting" nag over a session that had simply finished, a completed login,
 * the *answer* to a question the user has just given — each flipped the session to "needs input"
 * and fired an OS notification saying Claude needed them, over nothing that needed them.
 */
function notificationCommand(): string {
  return (
    `[ -n "$${STATE_FILE_ENV}" ] || exit 0; ` +
    `${readPayload('payload')}; ` +
    `${payloadField('payload', 'notification_type', 'kind')}; ` +
    `case "$kind" in ` +
    // Nothing is being asked: the nag is about a session already reported as done, and a finished
    // login is news to nobody. Writing no word leaves the dot saying what it already said.
    `idle_prompt|auth_success) exit 0 ;; ` +
    // The user has just answered — the one thing that is certainly not "waiting on the user".
    `elicitation_complete|elicitation_response) word=working ;; ` +
    // A permission prompt, an open question, a kind we have not met, or a Claude too old to say:
    // better to ask for a look that was not needed than to sit silent on one that was.
    `*) word=attention ;; ` +
    `esac; ` +
    `printf '%s\\n' "$word" >> "$${STATE_FILE_ENV}"; exit 0`
  )
}

/**
 * `StopFailure` fires in place of `Stop`, so this word is the whole record of a turn that ended on
 * an API error. Its `error` field is one of a fixed set of kinds; an older Claude that sends none
 * still lands as an error, because the turn ended either way.
 */
function stopFailureCommand(): string {
  return (
    `[ -n "$${STATE_FILE_ENV}" ] || exit 0; ` +
    `${readPayload('payload')}; ` +
    `${payloadField('payload', 'error', 'kind')}; ` +
    `[ -n "$kind" ] || kind=unknown; ` +
    `printf '%s %s\\n' '${TURN_FAILED}' "$kind" >> "$${STATE_FILE_ENV}"; exit 0`
  )
}

interface HookEntry {
  matcher?: string
  hooks: { type: 'command'; command: string }[]
}

function maestroHooks(): Record<string, HookEntry[]> {
  const out: Record<string, HookEntry[]> = {}
  for (const [event, state] of Object.entries(EVENT_STATE)) {
    out[event] = [{ hooks: [{ type: 'command', command: wordCommand(state) }] }]
  }
  out.SessionEnd = [{ hooks: [{ type: 'command', command: wordCommand(SESSION_ENDED) }] }]
  out.StopFailure = [{ hooks: [{ type: 'command', command: stopFailureCommand() }] }]
  out.Notification = [{ hooks: [{ type: 'command', command: notificationCommand() }] }]
  out.SubagentStart = [{ hooks: [{ type: 'command', command: subagentOpenCommand() }] }]
  out.SubagentStop = [{ hooks: [{ type: 'command', command: subagentCloseCommand() }] }]
  return out
}

/**
 * Installs the state hooks into a worktree. Merges into any existing local settings rather
 * than replacing them, and only ever touches the events we own.
 */
export async function installHooks(worktreePath: string): Promise<void> {
  const dir = join(worktreePath, '.claude')
  const file = join(dir, 'settings.local.json')
  await mkdir(dir, { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    // No local settings yet — start from empty.
  }

  const currentHooks = (existing.hooks ?? {}) as Record<string, HookEntry[]>
  const ours = maestroHooks()
  const merged: Record<string, HookEntry[]> = { ...currentHooks }

  for (const [event, entries] of Object.entries(ours)) {
    const kept = (currentHooks[event] ?? []).filter(
      (entry) => !entry.hooks?.some((h) => h.command?.includes(STATE_FILE_ENV))
    )
    merged[event] = [...kept, ...entries]
  }

  await writeFile(file, JSON.stringify({ ...existing, hooks: merged }, null, 2), 'utf8')
}

export interface AgentStateWatcher {
  on(event: 'state', listener: (sessionId: string, status: AgentStatus) => void): void
}

function isState(word: string): word is AgentState {
  return ['working', 'delegating', 'attention', 'done', 'interrupted', 'error', 'idle'].includes(
    word
  )
}

/** A sub-agent that has started and not yet stopped. */
interface OpenAgent {
  /** Empty when the payload carried none, which is all a legacy line or an older Claude gives. */
  id: string
  name: string
}

/** What the file says so far: the main agent's own state, and the sub-agents open around it. */
interface Fold {
  state: AgentState
  /** Most recently started last — Claude runs several at once, and nests them too. */
  open: OpenAgent[]
  /**
   * Whether Claude has handed the turn back. It ends its own turn when it launches a background
   * sub-agent, which is what makes that case different from a sub-agent it is blocked on: the
   * work is in flight, but the session will take a new prompt this second.
   */
  turnEnded: boolean
  /** Which API error ended the turn. Set only while {@link Fold.state} is `error`. */
  errorKind?: string
}

/**
 * Which open bracket a close ends, or -1 for none.
 *
 * By id where there is one: with two sub-agents out, the one that finishes first is not necessarily
 * the one that started last, and popping blind renames the survivor. An id that matches nothing open
 * can still be the close for a bracket written before ids existed — but only for one of those, never
 * for a bracket whose own id simply differs, which is how a stray stop used to cancel a real
 * sub-agent's run.
 */
function closes(open: OpenAgent[], id: string): number {
  if (!id) return open.length - 1
  const exact = open.findIndex((agent) => agent.id === id)
  return exact >= 0 ? exact : open.findLastIndex((agent) => !agent.id)
}

/**
 * Replays the whole file instead of reading its last line, because the last line does not mean
 * what it says on its own: Claude ends its turn — Stop, "done" — the moment it hands work to a
 * background sub-agent, and only the unclosed bracket around that Stop tells us the work is still
 * running. Reading one line is what left these sessions wearing a finished dot mid-review.
 */
export function foldEvents(text: string): Fold | null {
  let state: AgentState | null = null
  let turnEnded = false
  let errorKind = ''
  const open: OpenAgent[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    if (line === SESSION_ENDED) {
      /*
       * A finish outlives the agent that produced it — the reply is still sitting there to read,
       * and how the terminal was closed is no business of the sidebar's. But only a real finish:
       * a Stop with a sub-agent still out was a hand-off, and the work it handed off never came
       * back, so calling that "finished what you asked" is the original lie in a new costume.
       */
      const finished = state === 'done' && open.length === 0
      /*
       * A failure keeps whatever it had out, on the same terms and for a stronger reason: the
       * error is why the turn ended, and closing the terminal does not make it not have happened.
       */
      const failed = state === 'error'
      open.length = 0
      turnEnded = false
      if (!finished && !failed) state = 'idle'
      continue
    }

    if (line === SUBAGENT_CLOSE || line.startsWith(`${SUBAGENT_CLOSE} `)) {
      const at = closes(open, line.slice(SUBAGENT_CLOSE.length).trim())
      /*
       * A stop for something we never saw start, which is not a sub-agent coming back: Claude runs
       * its own forked queries through the same event — the session recap it writes when you return
       * to a session you left — and sends their SubagentStop with no SubagentStart before it. Taken
       * as a return, that recap woke a finished session back up to "working" and left it pulsing
       * there, because nothing was ever coming to end work that had never started.
       */
      if (at < 0) continue
      open.splice(at, 1)
      // Claude stopped its turn to wait on this sub-agent, so the result wakes it straight back
      // up: the session is working again, not finished, and holding its own turn once more.
      if (open.length === 0 && state === 'done') {
        state = 'working'
        turnEnded = false
      }
      continue
    }

    if (line.startsWith(SUBAGENT_OPEN)) {
      /*
       * "<id> <name>", either of which the payload may not have carried — an id-less line is one
       * word, and a nameless one leaves the id alone on the line. One word is read as the name,
       * which is both what a line written before ids existed meant and the more useful guess.
       */
      const words = line.slice(SUBAGENT_OPEN.length).trim().split(/\s+/).filter(Boolean)
      const id = words.length > 1 && words[0] !== NO_ID ? words[0] : ''
      const name = (words.length > 1 ? words.slice(1).join(' ') : words[0]) ?? ''
      open.push({ id, name: name.slice(0, MAX_LABEL) })
      continue
    }

    // "error <kind>", the kind being the one part of it worth keeping around.
    if (line === TURN_FAILED || line.startsWith(`${TURN_FAILED} `)) {
      state = 'error'
      errorKind = line.slice(TURN_FAILED.length).trim().slice(0, MAX_LABEL)
      // StopFailure fires instead of Stop, so this line is the turn ending as well as failing.
      turnEnded = true
      continue
    }

    if (!isState(line)) continue
    state = line
    // Whatever the session is up to now, it is not up to the error any more.
    errorKind = ''
    if (state === 'done') turnEnded = true
    // A heartbeat with a sub-agent out could be the sub-agent's own tool call, so it is no proof
    // the main agent took its turn back; with nothing out, it can only be Claude itself.
    if (state === 'working' && open.length === 0) turnEnded = false
    // Starting or ending a session settles every account — nothing can still be in flight — which
    // is also what clears a bracket left unclosed by a crash or a quit mid-review.
    if (state === 'idle') {
      open.length = 0
      turnEnded = false
    }
  }

  if (state === null && open.length === 0) return null
  return { state: state ?? 'idle', open, turnEnded, errorKind: errorKind || undefined }
}

/** The one state to show for a fold. */
function resolve(fold: Fold): AgentStatus {
  /*
   * An API error outranks everything, including a sub-agent still bracketed open: the turn it was
   * running under has ended, so nothing is coming back, and the error is the only fact the user
   * can act on.
   */
  if (fold.state === 'error') return { state: 'error', detail: fold.errorKind }
  if (fold.open.length === 0) return { state: fold.state }

  const detail = fold.open[fold.open.length - 1]?.name || undefined
  // Attention outranks a running sub-agent: whatever is in flight, Claude is asking for something
  // and that is the fact the user has to act on.
  if (fold.state === 'attention') return { state: 'attention' }
  /*
   * The distinction worth drawing between two sessions that both have a sub-agent out: one handed
   * the turn back when it launched it and will answer you now, the other is blocked on it and will
   * not. Only the first is delegating; the second is Claude working, with a name for what it waits
   * on.
   */
  if (!fold.turnEnded) return { state: 'working', detail }
  return { state: 'delegating', detail }
}

/** The shortest file that folds to the same thing — what housekeeping rewrites instead of erasing. */
function compact(fold: Fold): string {
  // Always two fields, so a name with a space in it survives the round trip.
  const brackets = fold.open.map((agent) => `${SUBAGENT_OPEN} ${agent.id || NO_ID} ${agent.name}`)
  /*
   * Ordered to replay into this same fold, which is not the order they were written in. The Stop
   * goes first and anything else last: a heartbeat written before the brackets open would read as
   * the main agent taking its turn back, and the session would lose the one fact that says it will
   * answer you while its sub-agent runs.
   */
  // The error's kind rides along with it, or a compacted file would come back as an error with
  // nothing to say which.
  const own = fold.state === 'error' ? `${TURN_FAILED} ${fold.errorKind ?? ''}`.trim() : fold.state
  const lines = fold.turnEnded
    ? ['done', ...brackets, ...(fold.state === 'done' ? [] : [own])]
    : [own, ...brackets]
  return lines.join('\n') + '\n'
}

class Watcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private states = new Map<string, AgentStatus>()
  private pending = new Map<string, NodeJS.Timeout>()
  private frozen = false

  async start(): Promise<void> {
    const dir = stateDir()
    await mkdir(dir, { recursive: true })
    this.watcher = watch(dir, (_event, filename) => {
      if (!filename || !filename.endsWith('.state')) return
      this.schedule(filename.replace(/\.state$/, ''))
    })
  }

  /** Reads a session's state file again, for events written while nothing was watching. */
  refresh(sessionId: string): void {
    this.schedule(sessionId)
  }

  /** fs.watch fires several times per append; collapse them. */
  private schedule(sessionId: string): void {
    const existing = this.pending.get(sessionId)
    if (existing) clearTimeout(existing)
    this.pending.set(
      sessionId,
      setTimeout(() => {
        this.pending.delete(sessionId)
        void this.read(sessionId)
      }, 30)
    )
  }

  private async read(sessionId: string): Promise<void> {
    const file = stateFileFor(sessionId)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return
    }
    const fold = foldEvents(text)
    if (!fold) return
    const status = resolve(fold)

    try {
      const info = await stat(file)
      // Rewritten rather than emptied: the file is now read as a whole, so erasing it mid-review
      // would drop the open bracket and the session would go back to looking finished.
      if (info.size > TRUNCATE_AT) await writeFile(file, compact(fold), 'utf8')
    } catch {
      // Housekeeping — never fatal.
    }

    const previous = this.states.get(sessionId)
    if (previous?.state === status.state && previous.detail === status.detail) return
    this.states.set(sessionId, status)
    this.emit('state', sessionId, status)
  }

  get(sessionId: string): AgentState {
    return this.states.get(sessionId)?.state ?? 'idle'
  }

  set(sessionId: string, state: AgentState): void {
    const status = { state }
    this.states.set(sessionId, status)
    this.emit('state', sessionId, status)
  }

  /**
   * The agent process is gone — quit, killed, crashed. Whatever it was in the middle of, it is not
   * in the middle of it any more, and only a clean exit sends SessionEnd: a killed Claude used to
   * leave the session pulsing "working" for as long as the app stayed open.
   *
   * A finish survives, because it is still a finish the user has not looked at.
   */
  settle(sessionId: string): void {
    // Quitting kills every agent at once, and those deaths are not news about the sessions: what
    // each one was doing when the app went down is exactly what the next launch has to know.
    if (this.frozen) return
    // Nor is a session that has been disposed of: its agent is killed on the way out, and the
    // exit lands after the session is gone, which would put a state back for a row that no
    // longer exists.
    if (!this.states.has(sessionId)) return
    const state = this.get(sessionId)
    // A finish survives, and so does a failure: "stopped mid-task" over an API error would trade a
    // reason the user can act on for one they cannot.
    if (state === 'done' || state === 'idle' || state === 'interrupted' || state === 'error') return
    // Stopped without finishing, which is a thing the user can do something about: a word from
    // them puts it back to work. Reporting that as idle hid a whole category of stuck session.
    this.set(sessionId, 'interrupted')
  }

  all(): Record<string, AgentStatus> {
    return Object.fromEntries(this.states)
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId)
    // The history goes with it. Archiving is reversible, and a restored session that replayed a
    // file from before it was archived would come back wearing whatever it wore then.
    void rm(stateFileFor(sessionId), { force: true })
  }

  /** Freezes the states as they are and stops watching. Called before the agents are killed. */
  stop(): void {
    this.frozen = true
    this.watcher?.close()
    this.watcher = null
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }
}

export const agentStates = new Watcher()
