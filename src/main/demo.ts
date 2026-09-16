import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { store } from './store'
import { profile } from './profile'

const exec = promisify(execFile)

/**
 * Gives a non-stable instance something real to work on.
 *
 * A dev profile starts with no repos, which is the safeguard — it cannot touch real work. The
 * obvious way round that is to add your actual repos, which throws the safeguard away: profile
 * isolation separates app state, not the filesystem, so a session created there cuts real
 * worktrees and a delete removes real directories.
 *
 * These are genuine git repositories, so worktrees, diffs, merge-back and setup scripts all behave
 * for real — they simply have nothing in them worth losing. They live inside the profile's own
 * directory, so removing the profile removes them too.
 */

interface DemoSpec {
  name: string
  files: Record<string, string>
  /** A second commit, so a session has history to sit on top of. */
  followUp: Record<string, string>
}

const DEMOS: DemoSpec[] = [
  {
    name: 'demo-web',
    files: {
      // Committed like any other file, which is what makes it reach every worktree. Exercises the
      // setup path and the "setup ✓" footer without installing anything.
      '.maestro/setup.sh':
        '#!/usr/bin/env bash\nset -euo pipefail\necho "installing demo-web dependencies…"\nsleep 1\necho done\n',
      'README.md': '# demo-web\n\nA throwaway repo for trying Maestro out.\n',
      'index.html': '<!doctype html>\n<title>demo-web</title>\n<h1>Hello</h1>\n',
      'app.js': "export function greet(name) {\n  return `Hello, ${name}`\n}\n"
    },
    followUp: {
      'app.js':
        "export function greet(name) {\n  return `Hello, ${name}!`\n}\n\nexport function farewell(name) {\n  return `Bye, ${name}`\n}\n"
    }
  },
  {
    name: 'demo-api',
    files: {
      'README.md': '# demo-api\n\nA throwaway repo for trying Maestro out.\n',
      'server.py': 'def health():\n    return {"ok": True}\n',
      'routes.py': 'ROUTES = ["/health"]\n'
    },
    followUp: {
      'routes.py': 'ROUTES = ["/health", "/version"]\n'
    }
  }
]

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd })
}

async function createRepo(root: string, spec: DemoSpec): Promise<string | null> {
  const path = join(root, spec.name)
  if (existsSync(path)) return path

  try {
    await mkdir(path, { recursive: true })
    await git(path, ['init', '-q', '-b', 'main'])
    // Set locally rather than relying on global config, which may be absent.
    await git(path, ['config', 'user.email', 'demo@maestro.local'])
    await git(path, ['config', 'user.name', 'Maestro Demo'])

    for (const [name, body] of Object.entries(spec.files)) {
      const file = join(path, name)
      await mkdir(dirname(file), { recursive: true })
      // Executable where it needs to be — git records the bit, so worktrees get it too.
      await writeFile(file, body, { encoding: 'utf8', mode: name.endsWith('.sh') ? 0o755 : 0o644 })
    }
    await git(path, ['add', '-A'])
    await git(path, ['commit', '-qm', 'Initial commit'])

    for (const [name, body] of Object.entries(spec.followUp)) {
      await writeFile(join(path, name), body, 'utf8')
    }
    await git(path, ['add', '-A'])
    await git(path, ['commit', '-qm', 'Extend the API surface'])

    return path
  } catch (err) {
    console.error(`[demo] could not create ${spec.name}`, err)
    return null
  }
}

/** Idempotent: seeds only a non-stable profile that has no repos yet. */
export async function seedDemoRepos(): Promise<void> {
  if (profile() === 'stable') return
  if (store.hasRepoRecords) return

  const root = join(app.getPath('userData'), 'demo-repos')
  await mkdir(root, { recursive: true })

  for (const spec of DEMOS) {
    const path = await createRepo(root, spec)
    if (!path) continue
    store.addRepo({ name: spec.name, path, defaultBranch: 'main' })
  }

  console.log(`[demo] seeded ${store.repos.length} demo repo(s) under ${root}`)
}
