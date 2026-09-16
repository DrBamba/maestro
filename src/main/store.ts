import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Preferences, Repo, Session } from '@shared/types'

interface Persisted {
  version: 1
  repos: Repo[]
  sessions: Session[]
  activeSessionId: string | null
  preferences: Preferences
}

const EMPTY: Persisted = {
  version: 1,
  repos: [],
  sessions: [],
  activeSessionId: null,
  // No migration entry: `load` spreads EMPTY first, so a file written before preferences existed
  // comes back with this default rather than an undefined.
  preferences: {}
}

/**
 * Repos and sessions on disk. Worktrees are the source of truth for git state; this only
 * records what the app should restore on relaunch.
 */
class Store {
  /*
   * Resolved on every use, never captured.
   *
   * As a field initializer this ran when the module was imported — which, because index.ts imports
   * the store before it calls configureProfile(), was before the profile had redirected userData.
   * The store therefore kept pointing at the stable directory even in a dev run, so a dev instance
   * read and wrote the real session file while everything else it touched was correctly isolated.
   * A getter cannot be captured early, so it does not depend on import order at all.
   */
  private get file(): string {
    return join(app.getPath('userData'), 'maestro.json')
  }
  private data: Persisted = EMPTY
  private flushTimer: NodeJS.Timeout | null = null

  /** Where this instance's sessions live — logged at startup so a wrong profile is visible. */
  get path(): string {
    return this.file
  }

  load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Persisted
      this.data = { ...EMPTY, ...parsed }
      this.migrate()
    } catch {
      this.data = { ...EMPTY, repos: [], sessions: [] }
    }
  }

  private migrate(): void {
    let changed = false

    for (const repo of this.data.repos) {
      // The setup script used to be text on the repo; it is now `.maestro/setup.sh` in the repo
      // itself. Nothing ever wrote the field but the demo repos, which write the file instead now.
      const legacy = repo as Repo & { setupScript?: string }
      if (legacy.setupScript !== undefined) {
        delete legacy.setupScript
        changed = true
      }

      // Records written before the run scripts existed carry no list, and it is read without a
      // guard — a repo has this field, and this is what says so.
      if (!Array.isArray(repo.runScripts)) {
        repo.runScripts = []
        changed = true
      }
    }

    for (const session of this.data.sessions) {
      /*
       * Setup ran in a pty, and ptys die with the app — so a session still `running` was quit
       * mid-script and its setup did not finish. Back to `pending`, which is the state that runs it
       * again when the session next opens. Left as it was, the tab would never re-spawn and a
       * session holding its first turn for setup would hold it forever.
       */
      if (session.setupState === 'running') {
        session.setupState = 'pending'
        changed = true
      }

      // Sessions written before ownership was modelled carry a single `adopted` flag. Adopted
      // meant "Maestro created neither the worktree nor the branch"; anything else, it created
      // both.
      const legacy = session as Session & { adopted?: boolean }
      if (typeof legacy.worktreeOwned !== 'boolean') {
        const adopted = legacy.adopted === true
        session.worktreeOwned = !adopted
        session.branchOwned = !adopted
        session.isPrimaryClone = false
        delete legacy.adopted
        changed = true
      }

      /*
       * Sessions relocated before `relocatedFrom` existed have no record of where they came from,
       * so their conversation history never syncs forward and stays frozen at the moment of the
       * move. The ownership pair identifies them unambiguously: relocation is the only path that
       * produces a Maestro-created worktree on a branch Maestro did not create.
       */
      if (
        session.relocatedFrom === undefined &&
        session.worktreeOwned &&
        !session.branchOwned &&
        !session.isPrimaryClone
      ) {
        const repo = this.data.repos.find((r) => r.id === session.repoId)
        if (repo) {
          session.relocatedFrom = repo.path
          changed = true
        }
      }
    }

    if (changed) this.flushNow()
  }

  /** Debounced atomic write — the UI mutates state far more often than the disk needs it. */
  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushNow()
    }, 250)
  }

  flushNow(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] write failed', err)
    }
  }

  get repos(): Repo[] {
    return this.data.repos
  }

  get sessions(): Session[] {
    return this.data.sessions
  }

  get activeSessionId(): string | null {
    return this.data.activeSessionId
  }

  get preferences(): Preferences {
    return this.data.preferences
  }

  /** Patched rather than replaced, so one setting can be written without knowing the others. */
  updatePreferences(patch: Partial<Preferences>): Preferences {
    this.data.preferences = { ...this.data.preferences, ...patch }
    this.flush()
    return this.data.preferences
  }

  setActiveSession(id: string | null): void {
    this.data.activeSessionId = id
    this.flush()
  }

  repo(id: string): Repo | undefined {
    return this.data.repos.find((r) => r.id === id)
  }

  session(id: string): Session | undefined {
    return this.data.sessions.find((s) => s.id === id)
  }

  addRepo(input: Omit<Repo, 'id' | 'collapsed' | 'runScripts'> & Partial<Repo>): Repo {
    const existing = this.data.repos.find((r) => r.path === input.path)
    if (existing) return existing
    const repo: Repo = {
      id: randomUUID(),
      name: input.name,
      path: input.path,
      defaultBranch: input.defaultBranch,
      runScripts: input.runScripts ?? [],
      collapsed: false
    }
    this.data.repos.push(repo)
    this.flush()
    return repo
  }

  updateRepo(id: string, patch: Partial<Repo>): Repo | undefined {
    const repo = this.repo(id)
    if (!repo) return undefined
    Object.assign(repo, patch, { id: repo.id })
    this.flush()
    return repo
  }

  removeRepo(id: string): void {
    this.data.repos = this.data.repos.filter((r) => r.id !== id)
    this.data.sessions = this.data.sessions.filter((s) => s.repoId !== id)
    this.flush()
  }

  addSession(session: Session): Session {
    this.data.sessions.push(session)
    this.flush()
    return session
  }

  updateSession(id: string, patch: Partial<Session>): Session | undefined {
    const session = this.session(id)
    if (!session) return undefined
    Object.assign(session, patch, { id: session.id })
    this.flush()
    return session
  }

  removeSession(id: string): void {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    if (this.data.activeSessionId === id) this.data.activeSessionId = null
    this.flush()
  }
}

export const store = new Store()
export { randomUUID }
