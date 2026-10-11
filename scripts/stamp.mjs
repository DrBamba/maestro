#!/usr/bin/env node
/**
 * Writes `out/release.json` — what a build is, for the boot loader and the updater to compare —
 * and `out/package.json`, which a release copied out of the checkout needs to load as ES modules.
 *
 *   node scripts/stamp.mjs [checkout]      # defaults to the current directory
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const out = join(root, 'out')

function git(...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  )
}

function hashDir(dir) {
  const hash = createHash('sha256')
  for (const file of files(dir).sort()) {
    hash.update(relative(dir, file)).update('\0').update(readFileSync(file)).update('\0')
  }
  return hash.digest('hex')
}

const commit = git('rev-parse', 'HEAD') || 'unknown'
const dirty = git('status', '--porcelain', '--untracked-files=no') !== ''
const builtAt = Date.now()
const time = new Date(builtAt).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const protocol = Number(
  /HOST_PROTOCOL = (\d+)/.exec(readFileSync(join(root, 'src/main/ptyProtocol.ts'), 'utf8'))?.[1]
)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// The repository proper, even when built from a worktree of it — where the app looks for updates.
const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir')

const stamp = {
  id: `${time}-${commit.slice(0, 8)}${dirty ? '-dirty' : ''}`,
  repo: commonDir ? dirname(commonDir) : '',
  commit,
  subject: git('log', '-1', '--format=%s'),
  builtAt,
  hostProtocol: protocol,
  dependencies: pkg.dependencies ?? {},
  hashes: {
    main: hashDir(join(out, 'main')),
    preload: hashDir(join(out, 'preload')),
    renderer: hashDir(join(out, 'renderer'))
  }
}

writeFileSync(join(out, 'release.json'), JSON.stringify(stamp, null, 2) + '\n')
writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
console.log(`stamped ${stamp.id}`)
