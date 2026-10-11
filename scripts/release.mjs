#!/usr/bin/env node
/**
 * Publishes a build of Maestro to the installed app, which switches to it while it runs.
 *
 *   npm run release                 # build, test and publish `main`
 *   npm run release -- --ref HEAD   # something else — a branch, a commit
 *   npm run release -- --quick      # only the live-update smoke tests, not the whole suite
 *   npm run release -- --no-tests   # no tests at all, for a ref already tested before it merged
 *
 * The commit is built in a scratch worktree of its own, so nothing half-edited in any checkout can
 * reach the running app, and two agents releasing at once take turns (a lock). A release must
 * contain the one already live: publishing an older branch cannot silently undo someone else's
 * shipped work. Pass --allow-rewind when that is the point.
 *
 * Set MAESTRO_USER_DATA_DIR to publish into a profile other than the installed app's.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const ref = option('--ref', 'main')
const quick = flag('--quick')
const noTests = flag('--no-tests')
const allowRewind = flag('--allow-rewind')

function fail(message) {
  console.error(`\nrelease: ${message}`)
  process.exit(1)
}

function run(cmd, cmdArgs, cwd, env = process.env) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env })
  if (result.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed`)
}

function git(...gitArgs) {
  return execFileSync('git', ['-C', here, ...gitArgs], { encoding: 'utf8' }).trim()
}

function isAncestor(older, newer) {
  return spawnSync('git', ['-C', here, 'merge-base', '--is-ancestor', older, newer]).status === 0
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function userData() {
  if (process.env.MAESTRO_USER_DATA_DIR) return process.env.MAESTRO_USER_DATA_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'maestro')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'maestro')
}

// ── what to build ────────────────────────────────────────────────────────────
let commit
try {
  commit = git('rev-parse', '--verify', `${ref}^{commit}`)
} catch {
  fail(`\`${ref}\` is not a commit in this repository.`)
}
const subject = git('log', '-1', '--format=%s', commit)
const releases = join(userData(), 'releases')
mkdirSync(releases, { recursive: true })

// ── one release at a time ────────────────────────────────────────────────────
const lock = join(releases, '.lock')
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
for (;;) {
  try {
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), String(process.pid))
    break
  } catch {
    let holder = 0
    try {
      holder = Number(readFileSync(join(lock, 'pid'), 'utf8').trim())
    } catch {
      // Taken a moment ago and not written yet.
      spawnSync('sleep', ['1'])
      continue
    }
    if (holder && alive(holder)) {
      console.log(`release: waiting for another release (pid ${holder}) to finish…`)
      spawnSync('sleep', ['5'])
    } else {
      rmSync(lock, { recursive: true, force: true })
    }
  }
}

let scratch = ''
function cleanup() {
  if (scratch) {
    spawnSync('git', ['-C', here, 'worktree', 'remove', '--force', scratch])
    rmSync(scratch, { recursive: true, force: true })
  }
  rmSync(lock, { recursive: true, force: true })
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))

// ── checks against what is live ──────────────────────────────────────────────
const currentId = (() => {
  try {
    return readFileSync(join(releases, 'current'), 'utf8').trim()
  } catch {
    return ''
  }
})()
const live = currentId ? readJson(join(releases, currentId, 'release.json')) : null
const builtin = readJson(join(releases, 'builtin.json'))

if (live?.commit === commit) {
  console.log(`release: ${commit.slice(0, 8)} is already live.`)
  process.exit(0)
}
if (live && !allowRewind && !isAncestor(live.commit, commit)) {
  fail(
    `\`${ref}\` does not contain the live release (${live.commit.slice(0, 8)} "${live.subject}").\n` +
      `Merge it first, or pass --allow-rewind to replace it anyway.`
  )
}

const wanted = JSON.parse(git('show', `${commit}:package.json`)).dependencies ?? {}
if (builtin && JSON.stringify(wanted) !== JSON.stringify(builtin.dependencies ?? {})) {
  fail('this commit changes runtime dependencies. Run `npm run install-stable` to reinstall instead.')
}

// ── build in a scratch worktree ──────────────────────────────────────────────
/*
 * Dependencies are borrowed from a checkout whose lockfile matches the commit's, rather than
 * installed: a fresh install rebuilds node-pty and takes minutes. The checkout that has the ref
 * checked out is the likeliest match, then this one.
 */
const lockfile = git('show', `${commit}:package-lock.json`)
const checkouts = git('worktree', 'list', '--porcelain')
  .split('\n')
  .filter((line) => line.startsWith('worktree '))
  .map((line) => line.slice('worktree '.length))
const donor = [here, ...checkouts].find(
  (dir) =>
    existsSync(join(dir, 'node_modules', 'electron')) &&
    existsSync(join(dir, 'package-lock.json')) &&
    readFileSync(join(dir, 'package-lock.json'), 'utf8').trim() === lockfile
)
if (!donor) fail('no checkout has dependencies installed for this commit. Run `npm install` in one.')

scratch = mkdtempSync(join(tmpdir(), 'maestro-release-'))
rmSync(scratch, { recursive: true, force: true })
run('git', ['-C', here, 'worktree', 'add', '--detach', scratch, commit], here)
symlinkSync(join(donor, 'node_modules'), join(scratch, 'node_modules'))

console.log(`\nrelease: building ${commit.slice(0, 8)} "${subject}"`)
run('npm', ['run', 'typecheck'], scratch)
run('npx', ['electron-vite', 'build'], scratch)
run('node', ['scripts/stamp.mjs', scratch], scratch)

// ── test it ──────────────────────────────────────────────────────────────────
if (noTests) {
  console.log('\nrelease: skipping tests')
} else {
  const specs = quick ? ['e2e/live-update.spec.ts'] : []
  run('npx', ['playwright', 'test', ...specs], scratch)
}

// ── publish ──────────────────────────────────────────────────────────────────
const stamp = readJson(join(scratch, 'out', 'release.json'))
const target = join(releases, stamp.id)
const partial = `${target}.partial`
rmSync(partial, { recursive: true, force: true })
cpSync(join(scratch, 'out'), partial, { recursive: true })
renameSync(partial, target)
writeFileSync(join(releases, `current.${process.pid}.partial`), stamp.id)
renameSync(join(releases, `current.${process.pid}.partial`), join(releases, 'current'))

// Keep the newest few, and whatever is current or last known good.
const keep = new Set([stamp.id, currentId, (() => {
  try {
    return readFileSync(join(releases, 'last-good'), 'utf8').trim()
  } catch {
    return ''
  }
})()])
const ids = readdirSync(releases, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}-/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
for (const id of ids.slice(0, -3)) {
  if (!keep.has(id)) rmSync(join(releases, id), { recursive: true, force: true })
}

const running = live ?? builtin
const note =
  running && running.hostProtocol !== stamp.hostProtocol
    ? 'It changes the terminal host, so it applies when Maestro is next restarted.'
    : 'Maestro switches to it within a few seconds.'
console.log(`\nrelease: published ${stamp.id} "${subject}". ${note}`)
