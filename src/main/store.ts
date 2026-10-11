import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Preferences, Repo, Session } from '@shared/types'

interface Persisted {
  version: 1
  repos: Repo[]
  sessions: Session[]
  activeSessionId: string | null
  preferences: Preferences
  /** How each session's tabs were arranged, by session id — opaque here, shaped by the renderer. */
  arrangements: Record<string, unknown>
}

const EMPTY: Persisted = {
  version: 1,
  repos: [],
  sessions: [],
  activeSessionId: null,
  // No migration entry: `load` spreads EMPTY first, so a file written before preferences existed
  // comes back with this default rather than an undefined.
  preferences: {},
  arrangements: {}
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
      this.data = { ...EMPTY, ...parsed, arrangements: parsed.arrangements ?? {} }
      this.migrate()
    } catch {
      this.data = { ...EMPTY, repos: [], sessions: [], arrangements: {} }
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

  /**
   * Batched atomic write — the UI mutates state far more often than the disk needs it.
   *
   * A change joins the write already pending rather than pushing it back: a stream of small ones,
   * like a pane being resized, must not hold a new session's record off the disk until it stops.
   */
  private flush(): void {
    if (this.flushTimer) return
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

  /** The repos in the sidebar — a removed repo's record is kept, but nothing sees it. */
  get repos(): Repo[] {
    return this.data.repos.filter((r) => !r.hidden)
  }

  /** Whether any repo was ever added, removed ones included. */
  get hasRepoRecords(): boolean {
    return this.data.repos.length > 0
  }

  /** Every session record, removed repos' included — for checks about what is on disk. */
  get allSessions(): Session[] {
    return this.data.sessions
  }

  /** Sessions of removed repos are out of sight along with the repo. */
  get sessions(): Session[] {
    const hidden = new Set(this.data.repos.filter((r) => r.hidden).map((r) => r.id))
    return hidden.size === 0
      ? this.data.sessions
      : this.data.sessions.filter((s) => !hidden.has(s.repoId))
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

  get arrangements(): Record<string, unknown> {
    return this.data.arrangements
  }

  /** Null forgets it. */
  setArrangement(sessionId: string, value: unknown): void {
    if (value === null || value === undefined) delete this.data.arrangements[sessionId]
    else this.data.arrangements[sessionId] = value
    this.flush()
  }

  private forgetArrangements(): void {
    const known = new Set(this.data.sessions.map((s) => s.id))
    for (const id of Object.keys(this.data.arrangements)) {
      if (!known.has(id)) delete this.data.arrangements[id]
    }
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
    // By real path too: git reports resolved paths, so a repo recorded through a symlink would
    // otherwise come back as a second record rather than as the removed one.
    const real = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return p
      }
    }
    const target = real(input.path)
    const existing = this.data.repos.find((r) => r.path === input.path || real(r.path) === target)
    if (existing) {
      if (existing.hidden) {
        delete existing.hidden
        // Their Claude was stopped when the repo was removed, so each picks its conversation back up.
        for (const session of this.data.sessions) {
          if (session.repoId === existing.id && !session.archived) session.restoredAt = Date.now()
        }
        this.flush()
      }
      return existing
    }
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

  /**
   * Puts the listed repos in that order. Removed repos are not on screen to be ordered, so they keep
   * their place at the end, and an id this store does not know is ignored.
   */
  reorderRepos(ids: string[]): void {
    const rank = new Map(ids.map((id, i) => [id, i]))
    const listed = this.data.repos.filter((r) => rank.has(r.id))
    listed.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
    this.data.repos = [...listed, ...this.data.repos.filter((r) => !rank.has(r.id))]
    this.flush()
  }

  /** The repo and every session record of it, for a repo whose folder is gone. */
  dropRepo(id: string): void {
    this.data.repos = this.data.repos.filter((r) => r.id !== id)
    this.data.sessions = this.data.sessions.filter((s) => s.repoId !== id)
    this.forgetArrangements()
    if (!this.data.sessions.some((s) => s.id === this.data.activeSessionId)) {
      this.data.activeSessionId = null
    }
    this.flush()
  }

  hideRepo(id: string): void {
    const repo = this.repo(id)
    if (!repo) return
    repo.hidden = true
    const active = this.data.sessions.find((s) => s.id === this.data.activeSessionId)
    if (active?.repoId === id) this.data.activeSessionId = null
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
    this.forgetArrangements()
    if (this.data.activeSessionId === id) this.data.activeSessionId = null
    this.flush()
  }
}

export const store = new Store()
export { randomUUID }
