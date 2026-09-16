import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile, chmod, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Drives the real application: real main process, real renderer, real IPC.
 *
 * Two things make that safe to do repeatedly.
 *
 * The profile is a throwaway directory, so the app cannot see or write the real session store —
 * and because a non-stable profile seeds demo repositories, every run starts from the same known
 * fixtures without any setup of its own.
 *
 * `claude` is resolved from PATH rather than hard-coded, so a stub earlier on PATH stands in for
 * the agent. Tests exercise the terminal without launching a real agent or spending tokens.
 */

interface Fixtures {
  app: ElectronApplication
  window: Page
  /** The throwaway profile directory, for asserting on what the app wrote. */
  profileDir: string
  /** Everything the stub agent was sent, so input can be verified without reading a canvas. */
  agentLog: () => Promise<string>
  /**
   * Stops the app and starts a fresh one on the same profile, returning the new window.
   *
   * What survives a restart is a real question the app answers — and the answer is only
   * observable by actually restarting it. `between` runs while nothing is holding the profile,
   * which is where a test can leave behind the on-disk state a crash would have left.
   */
  relaunch: (between?: () => Promise<void>) => Promise<Page>
}

/** Kept so the fixtures always close whichever instance is currently running. */
interface Running {
  app: ElectronApplication | null
}

async function launchApp(profileDir: string): Promise<ElectronApplication> {
  const binDir = join(profileDir, 'stub-bin')
  await mkdir(binDir, { recursive: true })
  const stub = join(binDir, 'claude')
  await writeFile(stub, CLAUDE_STUB, 'utf8')
  await chmod(stub, 0o755)

  return _electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      MAESTRO_USER_DATA_DIR: profileDir,
      // Never show the window: a test run must not take focus from the person using the machine.
      MAESTRO_HEADLESS: '1',
      MAESTRO_E2E_LOG: join(profileDir, 'agent-input.log'),
      // Worktrees go in the throwaway profile too, so runs cannot collide with each other.
      MAESTRO_WORKTREE_ROOT: join(profileDir, 'worktrees'),
      /*
       * Claude Code's own directory, which is where conversation history lives. Redirected into
       * the profile so the stub can leave transcripts behind — that is what makes "resume the
       * conversation" testable — without writing a single file into the real ~/.claude.
       */
      CLAUDE_CONFIG_DIR: join(profileDir, 'claude'),
      // Ahead of the real one, so the app resolves the stub.
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    }
  })
}

/**
 * A stand-in agent: prints a banner and stays alive, like an interactive REPL would.
 *
 * It also records what it receives. Terminal output cannot be asserted through the DOM — xterm
 * draws into a WebGL canvas, so the text is never in the document — so proving that keystrokes
 * reach the process is done by having the process write them down.
 *
 * And, like the real one, it leaves a transcript under the config directory keyed by the working
 * directory it ran in — separators and dots flattened to dashes. Whether a session comes back to
 * its old conversation is decided by whether that file is there, so the stub has to write it.
 */
const CLAUDE_STUB = `#!/bin/sh
# Recorded as well as printed: the opening message is passed as an argument, not typed, and the
# banner only reaches the WebGL canvas where no assertion can see it.
printf 'ARGS: %s\\n' "$*" >> "$MAESTRO_E2E_LOG"
if [ -n "$CLAUDE_CONFIG_DIR" ]; then
  history_dir="$CLAUDE_CONFIG_DIR/projects/$(pwd | tr './' '--')"
  mkdir -p "$history_dir"
  printf '{"type":"user","timestamp":"%s","message":{"content":"stub turn"}}\\n' \\
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$history_dir/stub-$$.jsonl"
fi
echo "stub-claude ready (args: $*)"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$MAESTRO_E2E_LOG"
  echo "you said: $line"
done
`

export const test = base.extend<Fixtures & { running: Running }>({
  profileDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'maestro-e2e-'))
    await use(dir)
    /*
     * Retried, because code-server outlives the window that embedded it: it is asked to exit as
     * the app quits and goes on flushing its user-data directory into the profile for a moment
     * afterwards, so a single rm loses a race and fails an otherwise passing test.
     */
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 9) throw err
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  },

  running: async ({}, use) => {
    await use({ app: null })
  },

  app: async ({ profileDir, running }, use) => {
    running.app = await launchApp(profileDir)
    await use(running.app)
    // Whichever instance is current, including one a relaunch put there.
    await running.app?.close()
  },

  relaunch: async ({ app, profileDir, running }, use) => {
    await use(async (between?: () => Promise<void>) => {
      await app.close()
      running.app = null
      await between?.()
      running.app = await launchApp(profileDir)
      const window = await running.app.firstWindow()
      await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
      return window
    })
  },

  agentLog: async ({ profileDir }, use) => {
    await use(async () => {
      try {
        return await readFile(join(profileDir, 'agent-input.log'), 'utf8')
      } catch {
        return ''
      }
    })
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow()
    // The sidebar renders once the snapshot has arrived; everything else depends on it.
    await window.waitForSelector('.sidebar__scroll', { timeout: 20_000 })
    await use(window)
  }
})

export const expect = test.expect

/**
 * Confirms an archive-or-delete dialog, once it knows what it is about to do.
 *
 * The dialog fills itself in from a plan it asks main for, and until that lands there is no WIP
 * choice on screen and the confirm button is disabled. Probing straight away reads "nothing to
 * settle" off a dialog that has not finished asking — and then waits out the timeout on a button
 * that never enables, because the plan arrives a moment later saying there was.
 *
 * There usually is: Maestro writes its hooks into every worktree and they are untracked, so unless
 * something on the machine ignores that file, removing the worktree destroys something.
 */
export async function confirmDispose(window: Page): Promise<void> {
  const dialog = window.locator('.modal')
  await expect(dialog.locator('.launcher__empty')).toHaveCount(0, { timeout: 30_000 })
  const discard = dialog.locator('.seg__opt:has-text("Discard them")')
  if (await discard.count()) await discard.click()
  await dialog.locator('.modal__actions .btn--primary').click()
}
