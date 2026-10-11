/**
 * Picks which build of Maestro this process runs, then runs it.
 *
 * The installed app carries a build of its own, and `npm run release` can publish newer ones beside
 * the user's data (see releases.ts). This starts the newest of those that is not known to be broken,
 * and backs out of one that fails to come up: a release that throws while loading, or that has not
 * produced a working window by the watchdog's deadline, is marked bad and the app relaunches onto
 * the previous one. Terminals live in the terminal host, so none of that touches a running agent.
 *
 * Kept tiny and dependency-free on purpose — this file is the one part an update never replaces.
 */
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { configureProfile } from './profile'
import { Releases, readStamp, releasesDir, type ReleaseStamp } from './releases'

const here = dirname(fileURLToPath(import.meta.url))
const WATCHDOG_MS = Number(process.env.MAESTRO_BOOT_WATCHDOG_MS) || 45_000

// Before anything reads userData: an unpackaged run must not share state with the packaged app.
configureProfile()

/** Releases are for the installed app. A dev run is its own source, and a test opts in. */
const releasesEnabled = app.isPackaged || process.env.MAESTRO_RELEASES === '1'

/** Starts over from the top, so the next attempt chooses again with the failure on record. */
function restart(): void {
  app.relaunch()
  app.exit(0)
}

async function boot(): Promise<void> {
  process.env.MAESTRO_RELEASE_ID = ''
  if (!releasesEnabled) {
    await import(pathToFileURL(join(here, 'app.js')).href)
    return
  }

  const releases = new Releases(releasesDir(app.getPath('userData')))
  const builtin = readStamp(join(here, '..'))
  releases.recordBuiltin(builtin)

  const stuck = releases.booting()
  if (stuck) releases.markBad(stuck, 'did not reach a working window')

  const candidate = [releases.current(), releases.lastGood()]
    .map((id) => releases.usable(id))
    .find((stamp): stamp is ReleaseStamp => !!stamp && stamp.builtAt > (builtin?.builtAt ?? 0))

  if (!candidate) {
    await import(pathToFileURL(join(here, 'app.js')).href)
    return
  }

  console.log(`[maestro] starting release ${candidate.id}`)
  releases.markBooting(candidate.id)
  process.env.MAESTRO_RELEASE_ID = candidate.id
  try {
    await import(pathToFileURL(join(releases.bundle(candidate.id), 'main', 'app.js')).href)
  } catch (err) {
    console.error(`[maestro] release ${candidate.id} failed to load`, err)
    releases.markBad(candidate.id, `failed to load: ${err instanceof Error ? err.message : String(err)}`)
    // Not the built-in straight away: half of the failed module may already have run.
    restart()
    return
  }

  setTimeout(() => {
    if (releases.booting() !== candidate.id) return
    console.error(`[maestro] release ${candidate.id} did not reach a working window`)
    releases.markBad(candidate.id, 'did not reach a working window in time')
    restart()
  }, WATCHDOG_MS).unref()
}

void boot()
