import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, confirmDispose } from './fixtures'

/**
 * The sidebar dot, driven the way the real hooks drive it.
 *
 * The stub agent does not run Claude Code's hooks, so the test appends the words itself — which is
 * the same contract the hooks have with the app, and the reason this is assertable at all.
 */

async function createSession(window: Page, name: string): Promise<{ id: string; path: string }> {
  await window.click('[aria-label="New session in demo-api"]')
  await window.fill('#session-name', name)
  await window.click('.modal__actions .btn--primary')
  await expect(window.locator('.session-row__name').first()).toHaveText(name, { timeout: 30_000 })
  /*
   * Not just the row — the agent has to have been launched before a word is put in its state file.
   * Launching resets the session to idle, which is right: nothing was running until now. But these
   * tests write the words the hooks would write, and a hook cannot fire before the agent starts, so
   * saying one first describes a sequence that cannot happen and the reset lands on top of it. The
   * terminal takes focus once the spawn has been answered, which makes it the signal that it has.
   */
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.className ?? ''), { timeout: 30_000 })
    .toContain('xterm-helper-textarea')
  const session = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => s.sessions[0])
  )
  return { id: session.id, path: session.worktreePath }
}

async function say(profileDir: string, sessionId: string, word: string): Promise<void> {
  const dir = join(profileDir, 'agent-state')
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, `${sessionId}.state`), `${word}\n`, 'utf8')
}

function dot(window: Page): ReturnType<Page['locator']> {
  return window.locator('.session-row').first().locator('.dot')
}

/**
 * Leaves the session with nothing in flight before the app is torn down.
 *
 * Quitting on work in progress is a native confirmation dialog — correct for a person, and
 * undriveable from here, so a test that ends mid-review hangs on close instead of finishing.
 */
async function settle(window: Page, profileDir: string, sessionId: string): Promise<void> {
  await say(profileDir, sessionId, 'idle')
  await expect(dot(window)).toHaveClass(/is-idle/)
}

test('a session running a sub-agent says so instead of looking finished', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'review the pagination fix')

  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)
  // Claude's own work is the plain disc; the stages that are about the user are symbols. Asserted
  // by icon class, because a glyph name that no longer exists renders as nothing at all.
  await expect(dot(window).locator('.dot__disc')).toHaveCount(1)

  /*
   * The bug this holds shut: Claude ends its own turn the moment it hands work to a background
   * sub-agent, so the file gets a Stop — "done" — while the review is still running. Read one line
   * at a time that is indistinguishable from finished, and the session sat there wearing a done dot
   * asking to be looked at.
   */
  await say(profileDir, session.id, 'subagent+ code-review')
  await say(profileDir, session.id, 'done')

  await expect(dot(window)).toHaveClass(/is-delegating/)
  await expect(dot(window)).not.toHaveClass(/is-done/)
  // Named, not just flagged: which sub-agent is running is the useful half of the signal.
  await expect(dot(window)).toHaveAttribute(
    'aria-label',
    'code-review running — free to take a prompt'
  )
  await expect(dot(window).locator('i.ph-arrow-bend-down-right')).toHaveCount(1)

  // The sub-agent's own tool calls beat the same heartbeat, and they are not the main agent going
  // back to work: while a bracket is open, and the turn already handed back, nothing has changed.
  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-delegating/)

  // The sub-agent's result wakes Claude back up, so this is not the finish either.
  await say(profileDir, session.id, 'subagent-')
  await expect(dot(window)).toHaveClass(/is-working/)

  // Claude's own Stop, with nothing outstanding, is.
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-done/)
  await expect(dot(window).locator('i.ph-eye')).toHaveCount(1)

  await say(profileDir, session.id, 'attention')
  await expect(dot(window).locator('i.ph-question-mark')).toHaveCount(1)
})

test('a sub-agent Claude is blocked on is Claude working, not a free session', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'blocking sub-agent')

  // No Stop, so Claude never handed the turn back: this one will not answer you until it returns.
  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'subagent+ Explore')

  await expect(dot(window)).toHaveClass(/is-working/)
  await expect(dot(window)).toHaveAttribute('aria-label', 'Working — waiting on Explore')

  await settle(window, profileDir, session.id)
})

test('a sub-agent that never names itself still reads as work in progress', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'explore the store')

  await say(profileDir, session.id, 'subagent+ ')
  await say(profileDir, session.id, 'done')


  await expect(dot(window)).toHaveClass(/is-delegating/)
  await expect(dot(window)).toHaveAttribute(
    'aria-label',
    'Sub-agent working — free to take a prompt'
  )

  await settle(window, profileDir, session.id)
})

test('a session start clears a bracket left open by a crash', async ({ window, profileDir }) => {
  const session = await createSession(window, 'left mid-review')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'subagent+ code-review')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-delegating/)

  // Nothing can still be in flight in a session that is only now starting, and the turn it was
  // holding is not held any more either.
  await say(profileDir, session.id, 'idle')
  await expect(dot(window)).toHaveClass(/is-idle/)
  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)
  await expect(dot(window)).toHaveAttribute('aria-label', 'Working — Claude has the turn')

  await settle(window, profileDir, session.id)
})

test('a turn the API ended reads as an error, not as a finish', async ({ window, profileDir }) => {
  const session = await createSession(window, 'rate limited mid-task')

  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)

  /*
   * Claude Code fires StopFailure in place of Stop when an API error ends the turn, so the reply
   * never came — and a session that died on a rate limit used to wear the same "your turn" eye as
   * one that had answered.
   */
  await say(profileDir, session.id, 'error rate_limit')
  await expect(dot(window)).toHaveClass(/is-error/)
  await expect(dot(window)).not.toHaveClass(/is-done/)
  await expect(dot(window).locator('i.ph-cloud-slash')).toHaveCount(1)
  // Which error, because a limit that clears itself and a login that has to be redone want
  // different things from the reader.
  await expect(dot(window)).toHaveAttribute('aria-label', 'API error: rate limit — the turn ended')

  // /exit or a closed terminal does not unhappen it, any more than it unhappens a finish.
  await say(profileDir, session.id, 'ended')
  await expect(dot(window)).toHaveClass(/is-error/)

  // Whatever the session does next is the news instead.
  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)

  await settle(window, profileDir, session.id)
})

test('an API error outranks a sub-agent still out', async ({ window, profileDir }) => {
  const session = await createSession(window, 'failed mid-review')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'subagent+ agent-1 code-review')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-delegating/)

  // The turn the review was running under has ended, so nothing is coming back to report on it.
  await say(profileDir, session.id, 'error overloaded')
  await expect(dot(window)).toHaveClass(/is-error/)
  await expect(dot(window)).toHaveAttribute(
    'aria-label',
    'API error: overloaded model — the turn ended'
  )

  await settle(window, profileDir, session.id)
})

test('an agent that dies mid-task says it stopped, not that it is free', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'killed mid-task')

  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)

  // Closing the agent's input ends the stub the way a crash or a kill ends the real one: the
  // process is gone without ever sending SessionEnd.
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.className ?? ''), { timeout: 15_000 })
    .toContain('xterm-helper-textarea')
  await window.keyboard.press('Control+d')

  await expect(dot(window)).toHaveClass(/is-interrupted/)
  await expect(dot(window).locator('i.ph-warning')).toHaveCount(1)
  await expect(dot(window)).toHaveAttribute(
    'aria-label',
    'Stopped mid-task — tell it to carry on'
  )
})

/**
 * The hook commands themselves, run the way Claude Code runs them: the shipped string, through
 * /bin/sh, with the real payload on stdin. Everything above drives the words; this covers the part
 * that decides which word gets written at all.
 */

type Hooks = Record<string, { hooks: { command: string }[] }[]>

async function hooksOf(worktree: string): Promise<Hooks> {
  const settings = JSON.parse(
    await readFile(join(worktree, '.claude', 'settings.local.json'), 'utf8')
  ) as { hooks: Hooks }
  return settings.hooks
}

async function fire(command: string, payload: unknown, stateFile: string): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      { env: { ...process.env, MAESTRO_STATE_FILE: stateFile } },
      (error) => (error ? reject(error) : resolve())
    )
    child.stdin?.end(JSON.stringify(payload))
  })
  return readFile(stateFile, 'utf8').catch(() => '')
}

test('only the notifications that are asking for something say so', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'notification kinds')
  const command = (await hooksOf(session.path)).Notification[0].hooks[0].command
  const file = join(profileDir, 'notify.state')

  const kinds = async (notification_type: string): Promise<string> => {
    await rm(file, { force: true })
    return fire(command, { hook_event_name: 'Notification', notification_type }, file)
  }

  expect(await kinds('permission_prompt')).toBe('attention\n')
  expect(await kinds('elicitation_dialog')).toBe('attention\n')

  // The 60-second nag over a session that had simply finished, and a completed login. Neither is
  // the user being asked anything, and both used to turn a green finished dot amber.
  expect(await kinds('idle_prompt')).toBe('')
  expect(await kinds('auth_success')).toBe('')

  // The answer to a question, which is the opposite of waiting for one.
  expect(await kinds('elicitation_response')).toBe('working\n')

  // A kind we have not met, and a Claude too old to name one: still worth a look.
  expect(await kinds('something_new')).toBe('attention\n')
  await rm(file, { force: true })
  expect(await fire(command, { hook_event_name: 'Notification' }, file)).toBe('attention\n')
})

test('the sub-agent hook writes down which sub-agent it is', async ({ window, profileDir }) => {
  const session = await createSession(window, 'sub-agent payloads')
  const hooks = await hooksOf(session.path)
  const file = join(profileDir, 'subagent.state')

  expect(Object.keys(hooks)).toEqual(
    expect.arrayContaining([
      'SessionStart',
      'Stop',
      'PostToolUse',
      'Notification',
      'StopFailure',
      'SubagentStart',
      'SubagentStop'
    ])
  )

  /*
   * Both fields out of one payload, which is the part that cannot be eyeballed: stdin is a stream,
   * so a command that reads it twice gets the second field empty and every sub-agent goes nameless.
   */
  const start = hooks.SubagentStart[0].hooks[0].command
  expect(await fire(start, { agent_type: 'code-review', agent_id: 'a1' }, file)).toBe(
    'subagent+ a1 code-review\n'
  )
  expect(await fire(hooks.SubagentStop[0].hooks[0].command, { agent_id: 'a1' }, file)).toBe(
    'subagent+ a1 code-review\nsubagent- a1\n'
  )

  // An older Claude that sends no id still names its agent.
  await rm(file, { force: true })
  expect(await fire(start, { agent_type: 'Explore' }, file)).toBe('subagent+  Explore\n')
})

test('the failure hook writes down which API error ended the turn', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'stop failure payloads')
  const command = (await hooksOf(session.path)).StopFailure[0].hooks[0].command
  const file = join(profileDir, 'failure.state')

  /*
   * `error_details` carries the API's own body, which is JSON with its own "error" key in it. Read
   * with one field too few of a pattern, the kind comes back as whatever that body happened to say.
   */
  expect(
    await fire(
      command,
      {
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: '{"type":"error","error":{"type":"rate_limit_error"}}'
      },
      file
    )
  ).toBe('error rate_limit\n')

  // A Claude too old to name a kind still ended its turn on an error, which is the half that matters.
  await rm(file, { force: true })
  expect(await fire(command, { hook_event_name: 'StopFailure' }, file)).toBe('error unknown\n')
})

test('a finish outlives the agent that produced it', async ({ window, profileDir }) => {
  const session = await createSession(window, 'finished then exited')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-done/)

  // /exit, Ctrl-D, closing the conversation. The reply is still sitting there unread, so how the
  // terminal was closed is no business of the sidebar's — this used to blank the dot to idle.
  await say(profileDir, session.id, 'ended')
  await expect(dot(window)).toHaveClass(/is-done/)
  await expect(dot(window).locator('i.ph-eye')).toHaveCount(1)
})

test('leaving mid-task clears the work but does not invent a finish', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'exited mid-task')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'subagent+ code-review')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-delegating/)

  await say(profileDir, session.id, 'ended')
  await expect(dot(window)).toHaveClass(/is-idle/)
})

test('work cut off by a restart comes back asking to be continued', async ({
  window,
  profileDir,
  relaunch
}) => {
  const session = await createSession(window, 'cut off by a restart')

  /*
   * The state a crash leaves on disk: a session recorded as working, with no interruption noted,
   * because nothing got the chance to note one. Written while no app holds the profile, which is
   * also the only way to reach this without the quit confirmation blocking the close.
   */
  const storeFile = join(profileDir, 'maestro.json')
  const next = await relaunch(async () => {
    const data = JSON.parse(await readFile(storeFile, 'utf8')) as {
      sessions: { id: string; agentState?: string; interruptedAt?: number }[]
    }
    data.sessions.find((s) => s.id === session.id)!.agentState = 'working'
    await writeFile(storeFile, JSON.stringify(data), 'utf8')
  })

  // Not idle, which is what it used to come back as: nothing is running, but the conversation
  // stopped mid-task and somebody has to tell it to carry on.
  await expect(dot(next)).toHaveClass(/is-interrupted/)
  await expect(dot(next)).toHaveAttribute('aria-label', 'Stopped mid-task — tell it to carry on')
  await expect(dot(next).locator('i.ph-warning')).toHaveCount(1)
})

test('a finish survives a restart as a finish', async ({ window, profileDir, relaunch }) => {
  const session = await createSession(window, 'finished before the restart')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-done/)

  const next = await relaunch()
  await expect(dot(next)).toHaveClass(/is-done/)
  await expect(dot(next).locator('i.ph-eye')).toHaveCount(1)
})

test('with two sub-agents out, the one still running is the one named', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'two at once')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'subagent+ agent-1 Explore')
  await say(profileDir, session.id, 'subagent+ agent-2 code-review')
  await say(profileDir, session.id, 'done')

  // The first to finish is not the last to have started, which is all a plain stack knows.
  await say(profileDir, session.id, 'subagent- agent-2')
  await expect(dot(window)).toHaveClass(/is-delegating/)
  await expect(dot(window)).toHaveAttribute('aria-label', 'Explore running — free to take a prompt')

  await say(profileDir, session.id, 'subagent- agent-1')
  await expect(dot(window)).toHaveClass(/is-working/)

  await settle(window, profileDir, session.id)
})

/**
 * Claude runs its own forked queries through the sub-agent events — the session recap it writes when
 * you come back to a session you left is one — and reports them with a SubagentStop that had no
 * SubagentStart before it. Read as a sub-agent coming back, that recap put finished sessions back to
 * work and cancelled the reviews of the ones that were really delegating.
 */

test('the recap Claude writes when you come back is not work starting again', async ({
  window,
  profileDir
}) => {
  const session = await createSession(window, 'recapped on return')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-done/)

  // The recap's stop, id and all, with nothing ever opened for it.
  await say(profileDir, session.id, 'subagent- a74078dedb034f17d')

  /*
   * Read back through a real sub-agent, because "still finished" is not assertable on its own — the
   * dot already said that, so the assertion would pass before the recap was ever read. A bracket
   * opened on a finished session is a hand-off, and Claude will take a prompt while it runs; the
   * version that took the recap for work starting again read the same bracket as Claude blocked on
   * it, which is the finish it had already thrown away showing through.
   */
  await say(profileDir, session.id, 'subagent+ agent-1 code-review')
  await expect(dot(window)).toHaveAttribute(
    'aria-label',
    'code-review running — free to take a prompt'
  )

  await say(profileDir, session.id, 'subagent- agent-1')
  await expect(dot(window)).toHaveClass(/is-working/)

  await settle(window, profileDir, session.id)
})

test('a recap mid-review does not end the review', async ({ window, profileDir }) => {
  const session = await createSession(window, 'recapped mid-review')

  await say(profileDir, session.id, 'working')
  await say(profileDir, session.id, 'subagent+ agent-1 code-review')
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-delegating/)

  // A stop for an id nothing opened must not stand in for the review that is out.
  await say(profileDir, session.id, 'subagent- a74078dedb034f17d')

  // Named through a second sub-agent, so the assertion cannot pass on the label it already had:
  // Explore covers the review while it runs, and code-review is only there to come back to if the
  // recap left it open.
  await say(profileDir, session.id, 'subagent+ agent-2 Explore')
  await expect(dot(window)).toHaveAttribute('aria-label', 'Explore running — free to take a prompt')
  await say(profileDir, session.id, 'subagent- agent-2')
  await expect(dot(window)).toHaveAttribute(
    'aria-label',
    'code-review running — free to take a prompt'
  )

  await say(profileDir, session.id, 'subagent- agent-1')
  await expect(dot(window)).toHaveClass(/is-working/)

  await settle(window, profileDir, session.id)
})

test('a disposed session takes its state file with it', async ({ window, profileDir }) => {
  const session = await createSession(window, 'about to be deleted')
  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)

  const stateFile = join(profileDir, 'agent-state', `${session.id}.state`)
  expect(existsSync(stateFile)).toBe(true)

  const row = window.locator('.session-row').first()
  await row.hover()
  await row.locator('[aria-label="Delete about to be deleted"]').click()
  const dialog = window.locator('.modal')
  await dialog.locator('.seg__opt:has-text("Delete")').click()
  /*
   * Removing the worktree destroys Maestro's own untracked hooks file, so the dialog asks what to
   * do with it first. This went unnoticed because a `~/.config/git/ignore` rule that hides that
   * file makes the question never appear — the test passed on the machine it was written on.
   */
  await confirmDispose(window)
  await expect(window.locator('.session-row__name')).toHaveCount(0, { timeout: 30_000 })

  // Killing the agent on the way out fires an exit for a session that no longer exists; nothing
  // it says should put a state back, and its history should not outlive it either.
  await expect.poll(() => existsSync(stateFile), { timeout: 15_000 }).toBe(false)
  const states = await window.evaluate(() =>
    window.maestro.snapshot().then((s) => Object.keys(s.agentStates))
  )
  expect(states).not.toContain(session.id)
})

test('looking at a question puts the light out and leaves the question', async ({
  window,
  profileDir
}) => {
  // Two sessions, so the one asking is not the one already being looked at.
  for (const name of ['asking me something', 'somewhere else']) {
    await window.click('[aria-label="New session in demo-api"]')
    await window.fill('#session-name', name)
    await window.click('.modal__actions .btn--primary')
    await expect(window.locator(`.session-row__name:text-is("${name}")`)).toHaveCount(1, {
      timeout: 30_000
    })
  }
  const sessions = await window.evaluate(() => window.maestro.snapshot().then((s) => s.sessions))
  const asking = sessions.find((s) => s.name === 'asking me something')!

  const row = window.locator('.session-row').filter({ hasText: 'asking me something' })
  const marker = row.locator('.dot')

  await say(profileDir, asking.id, 'working')
  await say(profileDir, asking.id, 'attention')
  await expect(marker).toHaveClass(/is-unseen/)

  /*
   * Opening the session is seeing it. From here Claude Code may say nothing for minutes — there is
   * no hook for a permission being answered — so the marker has to be readable as "this is what I
   * last knew" rather than as a fresh demand.
   */
  await row.click()
  await expect(marker).not.toHaveClass(/is-unseen/)
  // Still asking, because it is still asking.
  await expect(marker).toHaveClass(/is-attention/)
  await expect(marker.locator('i.ph-question-mark')).toHaveCount(1)

  // And the hooks are what take it down, whenever they next say anything.
  await say(profileDir, asking.id, 'working')
  await expect(marker).toHaveClass(/is-working/)

  await say(profileDir, asking.id, 'idle')
  await expect(marker).toHaveClass(/is-idle/)
})

/**
 * Counts attempts to make a sound by standing in for the constructor `playChime` reaches for. The
 * chime is Web Audio built on the fly rather than a file, so there is no request or element to
 * watch — the construction is the only observable moment, and it is observable before any audio
 * device has to exist.
 */
async function watchChimes(window: Page): Promise<() => Promise<number>> {
  await window.evaluate(() => {
    const w = window as unknown as { AudioContext: unknown; __chimes: number }
    const real = w.AudioContext as new (...args: unknown[]) => unknown
    w.__chimes = 0
    w.AudioContext = function (...args: unknown[]) {
      w.__chimes++
      return new real(...args)
    }
  })
  return () => window.evaluate(() => (window as unknown as { __chimes: number }).__chimes)
}

test('the finishing sound is off until it is asked for', async ({ window, profileDir }) => {
  const session = await createSession(window, 'quietly finishing')
  const chimes = await watchChimes(window)

  /*
   * The default, and the reason it is the default: a session finishing is normal and frequent, and
   * Maestro is usually behind another window when it happens. A noise nobody chose is one the user
   * has to go and find the setting for.
   */
  // Each step waited on before the next: two words written together arrive as one read, and the
  // state that never existed on its own is a state nothing was ever told about.
  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-done/)
  expect(await chimes()).toBe(0)

  await window.click('[aria-label="Settings"]')
  await window.click('.modal [aria-label="Play a sound when a session finishes"]')
  // Turning it on plays it once, so the answer to "what sound?" arrives with the decision.
  expect(await chimes()).toBe(1)
  await window.click('.modal__actions .btn--primary')

  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)
  await say(profileDir, session.id, 'done')
  await expect(dot(window)).toHaveClass(/is-done/)
  await expect.poll(chimes).toBe(2)

  // Work in progress is not an event about the user, and stays silent whichever way the setting is.
  await say(profileDir, session.id, 'working')
  await expect(dot(window)).toHaveClass(/is-working/)
  expect(await chimes()).toBe(2)

  // A setting, not a one-off: on disk for the next launch to read.
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(profileDir, 'maestro.json'), 'utf8')).preferences.chime,
      { timeout: 15_000 }
    )
    .toBe(true)

  await settle(window, profileDir, session.id)
})
