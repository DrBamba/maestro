import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fallbackShell, likelyToolDirs, platformOf } from '@shared/platform'

/**
 * Recovers the PATH the user actually has in their terminal.
 *
 * An app launched from Finder or /Applications inherits launchd's environment, not a shell's, so
 * PATH is roughly /usr/bin:/bin:/usr/sbin:/sbin. Everything Maestro shells out to except `git`
 * lives outside that — `claude` in ~/.local/bin, `gh` and `code-server` in Homebrew — so a packaged
 * build could create worktrees but not launch an agent, which surfaced only as "process exited with
 * code 1". Running from a terminal hid it, because that inherits the shell's PATH.
 *
 * Linux has the same problem by a different route: a launcher started from GNOME's app grid gets
 * systemd's environment, which has never read .bashrc either. So this is not a macOS workaround
 * that Linux merely tolerates — it is load-bearing on both, and only the directory names differ.
 *
 * The login shell is asked directly rather than guessing, since that is the thing that knows: it
 * sources the same profile that puts those directories on PATH in the first place.
 */

const platform = platformOf(process.platform)

/** Profiles can print banners, so the value is fenced rather than read from bare stdout. */
const MARKER = '__MAESTRO_PATH__'

/** A slow or interactive profile must not delay startup indefinitely. */
const TIMEOUT_MS = 3000

/**
 * Always unioned in, not only when the shell cannot be asked. Verified necessary: on this machine
 * ~/.local/bin — where `claude` lives — is added by .zshrc and so is absent from a non-interactive
 * shell's PATH, while Homebrew's directories come through fine. Cheap insurance against whichever
 * rc file a given setup happens to use.
 */
function fallbackDirs(): string[] {
  return likelyToolDirs(platform, homedir()).filter((dir) => existsSync(dir))
}

function askLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL || fallbackShell(platform)
  return new Promise((resolve) => {
    // Interactive *and* login: PATH additions frequently live in an interactive rc file (.zshrc,
    // .bashrc) rather than the login profile, and a login-only shell misses them — on this machine
    // that is exactly where `claude` comes from. The marker fencing tolerates the banners an
    // interactive shell prints, and the timeout covers one that blocks.
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`],
      { timeout: TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => {
        if (error && !stdout) return resolve(null)
        const match = stdout.split(MARKER)
        resolve(match.length >= 3 && match[1].trim() ? match[1].trim() : null)
      }
    )
  })
}

/**
 * Merges the login shell's PATH into this process, so every child — PTYs, git, gh, code-server —
 * inherits it. Existing entries keep priority; only missing directories are appended.
 */
export async function hydratePath(): Promise<{ resolved: boolean; added: string[] }> {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean)
  const seen = new Set(current)

  const fromShell = await askLoginShell()
  const candidates = [...(fromShell ? fromShell.split(':').filter(Boolean) : []), ...fallbackDirs()]

  const added: string[] = []
  for (const dir of candidates) {
    if (seen.has(dir)) continue
    seen.add(dir)
    added.push(dir)
  }

  if (added.length > 0) process.env.PATH = [...current, ...added].join(':')
  return { resolved: fromShell !== null, added }
}

/** Absolute path of a binary on the current PATH, or null. Used to fail loudly, not silently. */
export function resolveBinary(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}
