import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLocal } from '@shared/types'
import { store } from './store'

/**
 * Several local sessions can work in one folder, each with its own Claude. Nothing isolates them —
 * no worktree, no branch — so the only protection is the agents knowing about each other.
 *
 * That is told to them through `.claude/rules/`, which Claude Code loads at launch with the same
 * weight as the project's CLAUDE.md. A rules file of its own rather than an edit to CLAUDE.md or
 * CLAUDE.local.md, because those are the user's: Maestro can write and remove this one whole
 * without ever merging into anything somebody else wrote.
 *
 * Loaded at launch only, so an agent already running when the second session opens does not see it
 * until it is next started.
 */
export const SHARED_FOLDER_RULES = join('.claude', 'rules', 'maestro-shared-folder.md')

/*
 * The HTML comment is stripped before Claude reads the file, so it costs the agents nothing and
 * tells a person who finds it where it came from.
 */
export const SHARED_FOLDER_NOTE = `<!-- Written by Maestro while more than one session is open in this folder, and removed when only one is left. Once edited, Maestro leaves it alone. -->

# Other agents are working in this folder

Other Claude Code agents are running in this same directory at the same time as you, on their own
tasks. You share one working tree: no worktree or branch separates your changes from theirs.

- **Re-read a file right before editing it.** It may have changed since you last read it. Make small,
  targeted edits rather than rewriting whole files from memory.
- **Leave changes you did not make alone.** An unfamiliar edit, new file or failing build may be
  another agent's work in progress — do not revert, delete, reformat or "fix" it unless asked.
- **No tree-wide destructive commands.** Avoid \`git checkout .\`, \`git reset --hard\`, \`git clean\`,
  \`git stash\`, switching branches, rebasing, and project-wide formatters or codemods. They act on
  the other agents' work too.
- **Commit only your own files**, staged by path — never \`git add -A\` or \`git commit -a\`. Do not
  commit this file.
- **Only stop processes you started.** Dev servers, watchers and ports may belong to another agent;
  pick a free port instead of killing whatever holds one.
- **Expect interference.** If tests or the build break in code you did not touch, wait and retry or
  mention it rather than working around it.
- **When your work depends on a file another agent is changing, stop and tell the user.**
`

/** Open local sessions in `dir`, the session asking included. */
function openLocalSessionsIn(dir: string): number {
  return store.sessions.filter((s) => isLocal(s) && !s.archived && s.worktreePath === dir).length
}

/**
 * Puts the note in `dir` while two or more local sessions are open there, and takes it out again
 * once fewer are. A note the user has edited is theirs now and is left where it is.
 */
export async function syncSharedFolderNote(dir: string): Promise<void> {
  const file = join(dir, SHARED_FOLDER_RULES)
  try {
    const current = await readFile(file, 'utf8').catch(() => null)
    const edited = current !== null && current !== SHARED_FOLDER_NOTE
    if (edited) return
    if (openLocalSessionsIn(dir) > 1) {
      if (current !== null) return
      await mkdir(join(dir, '.claude', 'rules'), { recursive: true })
      await writeFile(file, SHARED_FOLDER_NOTE, 'utf8')
    } else if (current !== null) {
      await rm(file, { force: true })
    }
  } catch (err) {
    // The sessions still work without it; a folder Maestro cannot write to must not block opening.
    console.error('[sharedFolder] could not update the note in', dir, err)
  }
}
