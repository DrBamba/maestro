import { join } from 'node:path'
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises'

/**
 * A repo's setup script is a file in the repo — `.maestro/setup.sh` — rather than text held in
 * Maestro's own store. It is versioned with the code it sets up, so a clone from zero already knows
 * how to build itself: a new colleague adds the repo, cuts a session, and the worktree comes up
 * ready without anyone telling them what to run.
 *
 * That is also why it is written and edited inside a worktree like any other file in the repo, and
 * committed like one. A worktree runs the copy its own tree carries — nothing reaches in from
 * outside it — so what a branch's setup does is whatever that branch says it does.
 */
export const SETUP_SCRIPT_REL = join('.maestro', 'setup.sh')

/**
 * What a new script says before anyone edits it. No command is left active: the button that writes
 * this file can be clicked out of curiosity, and a template that installed something on every
 * worktree of every repo would be a strange thing to have guessed.
 *
 * The line about `# maestro: background` is deliberately prose rather than a commented-out
 * directive — {@link isBackground} matches a comment whose first word is `maestro:`, so a
 * copy-me-and-uncomment line would already be switched on.
 */
const TEMPLATE = `#!/usr/bin/env bash
# Runs in every new worktree of this repo, before Claude's first turn.
# Commit it: a fresh clone of the repo then sets itself up with no instructions.
#
# Claude waits for this to finish. Add a line reading "# maestro: background" to let
# it start while this runs instead.

set -euo pipefail

# Install dependencies, copy .env, warm caches — whatever a fresh worktree needs.
`

/** A directive line: a comment whose first word is `maestro:`. */
const BACKGROUND = /^[ \t]*#[ \t]*maestro:[ \t]*background\b/m

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** The setup script a directory carries, if it has one. */
export async function setupScriptIn(dir: string): Promise<string | null> {
  const path = join(dir, SETUP_SCRIPT_REL)
  return (await exists(path)) ? path : null
}

/** Whether the script has released Claude to start alongside it, rather than after it. */
export async function isBackground(path: string): Promise<boolean> {
  try {
    return BACKGROUND.test(await readFile(path, 'utf8'))
  } catch {
    return false
  }
}

function quote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`
}

/**
 * How to run it. An executable script is executed, so its shebang decides the interpreter; one
 * without the bit set is handed to bash, which is the shebang almost every such file would have
 * carried. Running it either way beats a `permission denied` in the setup tab for a script someone
 * added by hand.
 */
export async function setupCommand(path: string): Promise<string> {
  try {
    await access(path, constants.X_OK)
    return quote(path)
  } catch {
    return `bash ${quote(path)}`
  }
}

/**
 * The setup script in a worktree, created from {@link TEMPLATE} if the branch does not carry one
 * yet. An existing one is never touched — this is also the path taken by "edit the setup script",
 * which has nothing to create.
 */
export async function createSetupScript(
  worktreePath: string
): Promise<{ path: string; created: boolean }> {
  const path = join(worktreePath, SETUP_SCRIPT_REL)
  if (await exists(path)) return { path, created: false }
  await mkdir(join(worktreePath, '.maestro'), { recursive: true })
  // Executable, so the shebang it ships with is the one that runs it.
  await writeFile(path, TEMPLATE, { encoding: 'utf8', mode: 0o755 })
  return { path, created: true }
}
