import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Builds of Maestro that can replace the running one without reinstalling it.
 *
 * `npm run release` builds and tests a commit, copies the result into
 * `<userData>/releases/<id>/`, and points `current` at it. The installed app starts whichever is
 * newer — its own bundle or `current` — and a running one switches over by itself (updater.ts).
 * A release that fails to come up is written to `bad` and never started again.
 *
 *   releases/
 *     <id>/            main/ preload/ renderer/ release.json package.json
 *     current          the id to run
 *     last-good        the newest id that reached a working window
 *     booting          the id being started; still here next launch means it never came up
 *     bad              ids that failed, one per line
 *     builtin.json     the installed app's own stamp, for the release script to check against
 */

/** Written beside every build by scripts/stamp.mjs. */
export interface ReleaseStamp {
  id: string
  commit: string
  /** The repository it was built from, whose `main` the app watches for updates. */
  repo: string
  subject: string
  builtAt: number
  hostProtocol: number
  /** Runtime dependencies. A release can only use the ones the installed app already ships. */
  dependencies: Record<string, string>
  /** Content hashes, so an update that only touched the window can skip relaunching main. */
  hashes: { main: string; preload: string; renderer: string }
}

export function releasesDir(userData: string): string {
  return join(userData, 'releases')
}

export function readStamp(bundleDir: string): ReleaseStamp | null {
  try {
    return JSON.parse(readFileSync(join(bundleDir, 'release.json'), 'utf8')) as ReleaseStamp
  } catch {
    return null
  }
}

function readLine(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/** Replaced in one step, so a reader never sees half a file. */
function writeAtomic(file: string, text: string): void {
  const partial = `${file}.${process.pid}.partial`
  writeFileSync(partial, text, 'utf8')
  renameSync(partial, file)
}

export class Releases {
  constructor(readonly dir: string) {}

  current(): string {
    return readLine(join(this.dir, 'current'))
  }

  bundle(id: string): string {
    return join(this.dir, id)
  }

  isBad(id: string): boolean {
    return readLine(join(this.dir, 'bad')).split('\n').includes(id)
  }

  markBad(id: string, reason: string): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, 'bad'), `${id}\n`)
    appendFileSync(join(this.dir, 'bad.log'), `${new Date().toISOString()} ${id} ${reason}\n`)
    if (this.booting() === id) this.clearBooting()
  }

  booting(): string {
    return readLine(join(this.dir, 'booting'))
  }

  markBooting(id: string): void {
    mkdirSync(this.dir, { recursive: true })
    writeAtomic(join(this.dir, 'booting'), id)
  }

  clearBooting(): void {
    rmSync(join(this.dir, 'booting'), { force: true })
  }

  lastGood(): string {
    return readLine(join(this.dir, 'last-good'))
  }

  /** The running release reached a working window. */
  markHealthy(id: string): void {
    if (this.booting() === id) this.clearBooting()
    if (id && this.lastGood() !== id) writeAtomic(join(this.dir, 'last-good'), id)
  }

  /** A release that exists, is not known bad, and carries a readable stamp. */
  usable(id: string): ReleaseStamp | null {
    if (!id || this.isBad(id) || !existsSync(join(this.bundle(id), 'main', 'app.js'))) return null
    const stamp = readStamp(this.bundle(id))
    return stamp?.id === id ? stamp : null
  }

  recordBuiltin(stamp: ReleaseStamp | null): void {
    if (!stamp) return
    mkdirSync(this.dir, { recursive: true })
    writeAtomic(join(this.dir, 'builtin.json'), JSON.stringify(stamp, null, 2))
  }
}
