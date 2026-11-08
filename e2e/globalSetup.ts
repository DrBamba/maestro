import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { EXTENSIONS } from '../src/main/codeServerExtensions'

const exec = promisify(execFile)

/**
 * The editor's extensions, downloaded once per machine rather than once per test.
 *
 * A cold install is about 90 MB from Open VSX and takes 25–80s, and every editor test starts from
 * an empty profile. Tests that only need a working editor opt in with `test.use({ editorExtensions:
 * true })` and get a copy of this directory instead. The test of the install itself stays cold.
 *
 * Keyed by code-server version and the extension list, so upgrading either fetches fresh copies.
 */
export async function extensionCacheDir(): Promise<string | null> {
  let version: string
  try {
    version = (await exec('code-server', ['--version'])).stdout.split(/\s+/)[0]
  } catch {
    return null
  }
  const key = createHash('sha256').update(EXTENSIONS.join(',')).digest('hex').slice(0, 8)
  return resolve('node_modules/.cache/maestro-e2e', `code-server-${version}-${key}`)
}

export default async function globalSetup(): Promise<void> {
  const dir = await extensionCacheDir()
  if (!dir || existsSync(join(dir, 'extensions.json'))) return

  // Installed beside the cache and moved in only when complete, so a cut-off run leaves nothing.
  const staging = `${dir}.partial-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await exec(
      'code-server',
      [
        '--user-data-dir',
        join(staging, '.data'),
        '--extensions-dir',
        staging,
        ...EXTENSIONS.flatMap((id) => ['--install-extension', id])
      ],
      { timeout: 300_000 }
    )
    const manifest = (await readFile(join(staging, 'extensions.json'), 'utf8')).toLowerCase()
    const missing = EXTENSIONS.filter((id) => !manifest.includes(`"${id.toLowerCase()}"`))
    if (missing.length) throw new Error(`not installed: ${missing.join(', ')}`)
    await rm(join(staging, '.data'), { recursive: true, force: true })
    await rename(staging, dir)
  } catch (err) {
    // Not fatal: tests that asked for the cache fall back to downloading, as a cold profile does.
    console.warn('[e2e] could not cache editor extensions:', err)
    await rm(staging, { recursive: true, force: true })
  }
}
