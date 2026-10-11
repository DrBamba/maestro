import { useState } from 'react'
import type { AgentState, AgentStatus, Repo, Session, UpdateStatus } from '@shared/types'
import { isLocal } from '@shared/types'
import { relativeTime } from '../lib/format'

/*
 * Phrased as what the session wants from the reader, not as what happened to it. "Done" was the
 * clearest example of the difference: nothing about a session is over when a turn ends, and the
 * useful fact is that the next move is the user's.
 */
const STATE_WORD: Record<AgentState, string> = {
  working: 'Working — Claude has the turn',
  delegating: 'Sub-agent working — free to take a prompt',
  attention: 'Asking you — a question or a permission prompt',
  done: 'Your turn — finished what you asked',
  interrupted: 'Stopped mid-task — tell it to carry on',
  error: 'API error — the turn ended',
  idle: 'Ready — nothing running'
}

/**
 * Which API error, in the words a user would use. The kinds come from Claude Code's `StopFailure`
 * hook, and they are worth naming: a rate limit clears on its own, an expired login has to be
 * redone, and a billing problem is not fixed in this app at all.
 */
const ERROR_CAUSE: Record<string, string> = {
  rate_limit: 'rate limit',
  overloaded: 'overloaded model',
  server_error: 'server error',
  authentication_failed: 'expired login',
  oauth_org_not_allowed: 'org not allowed',
  billing_error: 'billing problem',
  invalid_request: 'rejected request',
  model_not_found: 'unknown model',
  max_output_tokens: 'output limit'
}

/**
 * How long a session must go without any activity before it counts as dormant. Long enough that a
 * session paused over lunch does not get flagged, short enough to catch the ones left behind.
 */
export const DORMANT_AFTER_MS = 8 * 60 * 60 * 1000

/**
 * A session nobody has talked to and no agent has worked in for {@link DORMANT_AFTER_MS}.
 *
 * Only the states that want nothing can sleep. An interrupted session in particular must not: a
 * restart usually follows a machine being off overnight, which is well past this line, so sleep
 * would swallow exactly the sessions that came back needing to be told to carry on.
 */
export function isDormant(session: Session, state: AgentState, now: number): boolean {
  if (session.archived) return false
  if (state !== 'done' && state !== 'idle') return false
  return now - session.lastActivity > DORMANT_AFTER_MS
}

/**
 * A symbol for every state except the two that are simply "Claude has it" and "nothing here",
 * which stay a plain disc — a pulsing dot says "alive" better than any glyph does at this size.
 *
 * Reading the sidebar used to mean hovering every row in it, because one colour of dot carried
 * every stage. The ones worth telling apart at a glance are those where the session is either out
 * of Claude's hands or in the user's.
 */
const STATE_MARK: Partial<Record<AgentState, string>> = {
  delegating: 'ph-arrow-bend-down-right',
  // The bare mark, not Phosphor's circled one: at this size a ring is what idle already looks like.
  attention: 'ph-question-mark',
  // An eye, not a tick. A tick says complete — archive me — when what a finished turn actually
  // wants is to be read and told what comes next.
  done: 'ph-eye',
  interrupted: 'ph-warning',
  // Not the warning triangle again: the turn ended on the API's answer, not on anything in the
  // worktree, and the two states are next to each other in the list often enough to want telling
  // apart without reading the colour.
  error: 'ph-cloud-slash'
}

/** What the dot says on hover: the state, sharpened by whatever detail came with it. */
function stateWord(state: AgentState, detail?: string, unseen?: boolean): string {
  // Which sub-agent, and whether the session will still answer while it runs.
  if (state === 'delegating' && detail) return `${detail} running — free to take a prompt`
  if (state === 'working' && detail) return `Working — waiting on ${detail}`
  // Which error, whenever Claude named a kind we have words for.
  if (state === 'error' && detail && ERROR_CAUSE[detail]) {
    return `API error: ${ERROR_CAUSE[detail]} — the turn ended`
  }
  if (state === 'done' && unseen) return 'Your turn — finished, not looked at yet'
  return STATE_WORD[state]
}

/**
 * `unseen` distinguishes a result you have not looked at from one you have — both "done" states are
 * legitimately done, but only the unseen one is what the chime was about. `dormant` is the opposite
 * end: nothing has happened here for a long time, so it is a candidate for archiving.
 */
export function StateDot({
  state,
  detail,
  unseen,
  dormant
}: {
  state: AgentState
  /** The sub-agent's name, or the API error's kind — "rate limit" beats "something went wrong". */
  detail?: string
  unseen?: boolean
  dormant?: boolean
}): React.JSX.Element {
  const word = dormant ? 'Sleeping — no activity for a while' : stateWord(state, detail, unseen)

  // The dormant marker replaces the dot rather than decorating it: the state it would show is
  // stale by definition, and "asleep" is the useful fact.
  if (dormant) {
    return (
      <span className="dot-sleep" title={word} aria-label={word}>
        z
      </span>
    )
  }

  const mark = STATE_MARK[state]
  return (
    <span
      className={`dot is-${state}${unseen ? ' is-unseen' : ''}`}
      title={word}
      aria-label={word}
    >
      {mark ? <i className={`ph ${mark}`} /> : <span className="dot__disc" />}
    </span>
  )
}

/** The live rows of one group, in the order they are listed. `null` is the Local group. */
export function groupRows(sessions: Session[], repoId: string | null): Session[] {
  return sessions.filter((s) =>
    repoId === null ? isLocal(s) && !s.archived : s.repoId === repoId && !s.archived
  )
}

/**
 * Local rows in the order they read on screen. Sessions sharing a folder are listed together where
 * the first of them sits, the same gathering {@link GroupBody} draws — so a session opened between
 * two that share a folder reads after both of them.
 */
function gatheredByFolder(rows: Session[]): Session[] {
  const byFolder = new Map<string, Session[]>()
  for (const session of rows) {
    byFolder.set(session.worktreePath, [...(byFolder.get(session.worktreePath) ?? []), session])
  }
  const placed = new Set<string>()
  return rows.flatMap((session) => {
    if (placed.has(session.worktreePath)) return []
    placed.add(session.worktreePath)
    return byFolder.get(session.worktreePath) ?? [session]
  })
}

/**
 * Every session the sidebar is currently showing, in reading order — what the number chords count.
 *
 * A collapsed group is skipped, so ⌘3 is the third row on screen rather than the third that would be
 * there if everything were open.
 */
export function sidebarOrder(
  repos: Repo[],
  sessions: Session[],
  localCollapsed: boolean
): Session[] {
  return [
    ...(localCollapsed ? [] : gatheredByFolder(groupRows(sessions, null))),
    ...repos.flatMap((repo) => (repo.collapsed ? [] : groupRows(sessions, repo.id)))
  ]
}

interface GroupBodyProps {
  rows: Session[]
  archived: Session[]
  /** Shown when the group has nothing in it — a group is never silently blank. */
  emptyText: string
  /**
   * Sessions working in the same folder sit together under that folder's name. Only for Local:
   * a repo session always has a worktree of its own, so nothing there could share one.
   */
  groupByFolder?: boolean
  agentStates: Record<string, AgentStatus>
  unseenSet: Set<string>
  activeId: string | null
  now: number
  onSelect: (id: string) => void
  onRestore: (id: string) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string) => void
  /** Deletes every session sharing a folder — only where sessions are grouped by folder. */
  onDeleteFolder?: (path: string) => void
}

/** A folder's own name, which is what the user pointed Maestro at. */
function folderName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/**
 * The rows under a group heading. Shared by the repos and by Local, so a local session behaves like
 * any other in the list — same dots, same hover actions, same archived drawer — rather than being a
 * second kind of row that drifts from the first.
 */
function GroupBody({
  rows,
  archived,
  emptyText,
  groupByFolder = false,
  agentStates,
  unseenSet,
  activeId,
  now,
  onSelect,
  onRestore,
  onArchive,
  onDelete,
  onRename,
  onDeleteFolder
}: GroupBodyProps): React.JSX.Element {
  const [showArchived, setShowArchived] = useState(false)

  const renderRow = (session: Session, nested = false): React.JSX.Element => {
    const status = agentStates[session.id]
    const state = status?.state ?? 'idle'
    const dormant = isDormant(session, state, now)
    return (
      // A div, not a button: the row holds its own action buttons, and a button
      // cannot legally contain buttons.
      <div
        key={session.id}
        className={`session-row${nested ? ' session-row--nested' : ''}${session.id === activeId ? ' is-active' : ''}${dormant ? ' is-dormant' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(session.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(session.id)
          }
        }}
      >
        <StateDot
          state={state}
          detail={status?.detail}
          unseen={unseenSet.has(session.id)}
          dormant={dormant}
        />
        <span className="session-row__name" data-tip={session.name}>
          {session.name}
        </span>
        <span className="session-row__time">{relativeTime(session.lastActivity, now)}</span>
        {/* Hidden until hover, except on sleeping rows where they are the point. */}
        <span className="session-row__actions">
          <button
            className="session-row__action"
            title="Rename session…"
            aria-label={`Rename ${session.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onRename(session.id)
            }}
          >
            <i className="ph ph-pencil-simple" />
          </button>
          <button
            className="session-row__action"
            title="Archive session…"
            aria-label={`Archive ${session.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onArchive(session.id)
            }}
          >
            <i className="ph ph-archive" />
          </button>
          <button
            className="session-row__action is-danger"
            title="Delete session…"
            aria-label={`Delete ${session.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(session.id)
            }}
          >
            <i className="ph ph-trash" />
          </button>
        </span>
      </div>
    )
  }

  /*
   * A folder with one session is just a row. Two or more become one entry, placed where the first
   * of them would have been, so the list keeps its order and only gathers.
   */
  const byFolder = new Map<string, Session[]>()
  if (groupByFolder) {
    for (const session of rows) {
      byFolder.set(session.worktreePath, [...(byFolder.get(session.worktreePath) ?? []), session])
    }
  }
  const placed = new Set<string>()

  return (
    <>
      {rows.map((session) => {
        const shared = byFolder.get(session.worktreePath) ?? []
        if (shared.length < 2) return renderRow(session)
        if (placed.has(session.worktreePath)) return null
        placed.add(session.worktreePath)
        return (
          <div
            className="folder-group"
            key={`folder:${session.worktreePath}`}
            role="group"
            aria-label={session.worktreePath}
          >
            <div className="folder-head" data-tip={session.worktreePath}>
              <i className="ph ph-folder-simple" />
              <span className="folder-head__name">{folderName(session.worktreePath)}</span>
              <span className="folder-head__count">{shared.length}</span>
              {onDeleteFolder && (
                <button
                  className="icon-btn-bare folder-head__delete"
                  onClick={() => onDeleteFolder(session.worktreePath)}
                  aria-label={`Delete sessions in ${folderName(session.worktreePath)}`}
                  title="Delete these sessions…"
                >
                  <i className="ph ph-trash" />
                </button>
              )}
            </div>
            {shared.map((member) => renderRow(member, true))}
          </div>
        )
      })}

      {rows.length === 0 && (
        <div className="sidebar__empty" style={{ padding: '4px 12px 8px' }}>
          {emptyText}
        </div>
      )}

      {/* Archived sessions are reachable, otherwise archiving would just be a delete. */}
      {archived.length > 0 && (
        <>
          <button className="archived-toggle" onClick={() => setShowArchived((v) => !v)}>
            <i className={`ph ph-caret-down repo-head__caret${showArchived ? '' : ' is-collapsed'}`} />
            {archived.length} archived
          </button>

          {showArchived &&
            archived.map((session) => (
              <div className="session-row is-archived" key={session.id}>
                <i
                  className="ph ph-archive"
                  style={{ fontSize: 13, color: 'var(--color-neutral-700)', flexShrink: 0 }}
                />
                {/* The branch or path rides along as a second line: an archived row is often the
                    only place left to see which one it was. */}
                <span
                  className="session-row__name"
                  data-tip={session.name}
                  data-tip-hint={session.branch || session.worktreePath}
                >
                  {session.name}
                </span>
                <button
                  className="session-row__restore"
                  title="Restore this session"
                  aria-label={`Restore ${session.name}`}
                  onClick={() => onRestore(session.id)}
                >
                  <i className="ph ph-arrow-counter-clockwise" />
                </button>
                {/*
                  * Archiving is not the end of it: a branch nobody will go back to still shows up in
                  * every branch list, and the only way out used to be restoring the session first.
                  */}
                <button
                  className="session-row__restore is-danger"
                  title="Delete this session…"
                  aria-label={`Delete ${session.name}`}
                  onClick={() => onDelete(session.id)}
                >
                  <i className="ph ph-trash" />
                </button>
              </div>
            ))}
        </>
      )}
    </>
  )
}

interface SidebarProps {
  repos: Repo[]
  sessions: Session[]
  agentStates: Record<string, AgentStatus>
  unseen: string[]
  /** Marks a non-stable instance, so two open windows are tellable apart. */
  profile: 'stable' | 'dev' | 'custom'
  /** The branch this instance is running out of — what actually distinguishes two dev windows. */
  sourceLabel: string
  activeId: string | null
  now: number
  /** Held by the shell, because the number chords count only the rows actually listed. */
  localCollapsed: boolean
  onSelect: (id: string) => void
  onNewSession: (repoId?: string) => void
  /** Opens a folder with no repo behind it. */
  onNewLocal: () => void
  onToggleLocal: () => void
  onToggleRepo: (repoId: string) => void
  onAddRepo: () => void
  onRemoveRepo: (repoId: string) => void
  /** Every listed repo's id, in the order they were dragged into. */
  onReorderRepos: (ids: string[]) => void
  onDeleteLocalFolder: (path: string) => void
  onRestore: (id: string) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string) => void
  onOpenSettings: () => void
  onOpenAbout: () => void
  update: UpdateStatus
  onUpdate: () => void
  onUpdateCancel: () => void
  onUpdateLog: () => void
}

const BUILD_STEP: Record<'build' | 'test' | 'publish', string> = {
  build: 'Building…',
  test: 'Testing…',
  publish: 'Installing…'
}

/** One row above the footer, and only when there is something newer. Nothing updates until pressed. */
function UpdateBar({
  update,
  onUpdate,
  onUpdateCancel,
  onUpdateLog
}: {
  update: UpdateStatus
  onUpdate: () => void
  onUpdateCancel: () => void
  onUpdateLog: () => void
}): React.JSX.Element | null {
  if (update.state === 'none') return null

  const log = (
    <button className="icon-btn-bare" onClick={onUpdateLog} aria-label="Update log" data-tip="Log">
      <i className="ph ph-file-text" style={{ fontSize: 15 }} />
    </button>
  )

  switch (update.state) {
    case 'available':
    case 'ready':
      return (
        <div className="sidebar__update">
          <button
            className="btn btn--small btn--update"
            onClick={onUpdate}
            aria-label="Update Maestro"
            data-tip={update.subject}
          >
            <i className="ph ph-arrow-circle-up" style={{ fontSize: 14 }} />
            Update
          </button>
          {update.state === 'available' && (
            <span className="sidebar__update-note">
              {update.changes === 1 ? '1 change' : `${update.changes} changes`}
            </span>
          )}
        </div>
      )
    case 'building':
    case 'applying':
      return (
        <div className="sidebar__update">
          <span className="spinner" />
          <span className="sidebar__update-note">
            {update.state === 'applying' ? 'Updating…' : BUILD_STEP[update.step]}
          </span>
          {update.state === 'building' && update.step !== 'publish' && (
            <button
              className="icon-btn-bare"
              onClick={onUpdateCancel}
              aria-label="Cancel update"
              data-tip="Cancel update"
            >
              <i className="ph ph-x" style={{ fontSize: 15 }} />
            </button>
          )}
          {log}
        </div>
      )
    case 'failed':
      return (
        <div className="sidebar__update">
          <span className="sidebar__update-note is-bad" data-tip={update.message}>
            {update.message}
          </span>
          <button className="btn btn--small" onClick={onUpdate} aria-label="Retry update">
            Retry
          </button>
          {log}
        </div>
      )
    case 'restart':
      return (
        <div className="sidebar__update">
          <button
            className="btn btn--small btn--update"
            onClick={onUpdate}
            aria-label="Restart to update"
            data-tip="Claude sessions restart"
          >
            <i className="ph ph-arrow-clockwise" style={{ fontSize: 14 }} />
            Restart to update
          </button>
        </div>
      )
  }
}

export default function Sidebar({
  repos,
  sessions,
  agentStates,
  unseen,
  profile,
  sourceLabel,
  activeId,
  now,
  localCollapsed,
  onSelect,
  onNewSession,
  onNewLocal,
  onToggleLocal,
  onToggleRepo,
  onAddRepo,
  onRemoveRepo,
  onReorderRepos,
  onDeleteLocalFolder,
  onRestore,
  onArchive,
  onDelete,
  onRename,
  onOpenSettings,
  onOpenAbout,
  update,
  onUpdate,
  onUpdateCancel,
  onUpdateLog
}: SidebarProps): React.JSX.Element {
  const unseenSet = new Set(unseen)
  const rowProps = {
    agentStates,
    unseenSet,
    activeId,
    now,
    onSelect,
    onRestore,
    onArchive,
    onDelete,
    onRename
  }
  /*
   * A repo is dragged by its heading and dropped anywhere in the list. Where it lands is the slot
   * the pointer is in, counted against the middle of each repo group — so a drop on Local or above
   * the first repo makes it first, and one in the empty space under the last makes it last. Local
   * itself never moves: it is not a repo, and it always heads the list.
   */
  const [dragged, setDragged] = useState<string | null>(null)
  /** The slot the drop would take, as an index among the repos — null where it would move nothing. */
  const [slot, setSlot] = useState<number | null>(null)
  const endDrag = (): void => {
    setDragged(null)
    setSlot(null)
  }
  const slotAt = (list: HTMLElement, y: number): number | null => {
    const from = repos.findIndex((r) => r.id === dragged)
    const at = [...list.querySelectorAll<HTMLElement>('[data-repo-id]')].filter((group) => {
      const box = group.getBoundingClientRect()
      return box.top + box.height / 2 < y
    }).length
    return at === from || at === from + 1 ? null : at
  }
  const dropRepo = (): void => {
    if (dragged && slot !== null) {
      const from = repos.findIndex((r) => r.id === dragged)
      const ids = repos.map((r) => r.id).filter((id) => id !== dragged)
      ids.splice(slot > from ? slot - 1 : slot, 0, dragged)
      onReorderRepos(ids)
    }
    endDrag()
  }

  const localRows = groupRows(sessions, null)
  const localArchived = sessions
    .filter((s) => isLocal(s) && s.archived)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))

  return (
    <aside className="sidebar">
      <div className="sidebar__titlebar">
        {/*
         * The wordmark stands down for the session name. This row is narrow — the traffic lights
         * take the first 80px of it — and a name is a sentence, so sharing the space left both a
         * dozen characters of the name and a product name nobody is in doubt about. Which of
         * several dev windows this is, is the question actually being asked here.
         */}
        {!sourceLabel && <span className="sidebar__wordmark">MAESTRO</span>}
        {profile !== 'stable' && (
          <span
            className={`sidebar__profile${sourceLabel ? ' sidebar__profile--source' : ''}`}
            /*
             * Even with the row to itself a name will often be clipped, so hovering is how it is
             * read in full. The name leads; what kind of window this is goes on the second line,
             * where it does not push the answer out of view.
             */
            data-tip={sourceLabel || 'Separate data directory'}
            data-tip-hint={sourceLabel ? 'Separate data directory' : undefined}
          >
            {sourceLabel || profile}
          </span>
        )}
      </div>

      <div
        className="sidebar__scroll"
        onDragOver={(e) => {
          if (!dragged) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const next = slotAt(e.currentTarget, e.clientY)
          if (next !== slot) setSlot(next)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSlot(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dropRepo()
        }}
      >
        {/*
         * Local sits above the repos, and stays visible when it is empty: it is the answer to
         * "I just want a terminal here", and an entry point nobody can find is not one.
         */}
        <div className="repo-group repo-group--local">
          <div className="repo-head">
            <button
              className="icon-btn-bare"
              onClick={onToggleLocal}
              aria-label={localCollapsed ? 'Expand local' : 'Collapse local'}
            >
              <i className={`ph ph-caret-down repo-head__caret${localCollapsed ? ' is-collapsed' : ''}`} />
            </button>
            <span className="repo-head__name" title="Folders with no repo behind them">
              Local
            </span>
            <button
              className="icon-btn-bare"
              onClick={onNewLocal}
              aria-label="New local session"
              title="Open a folder — no repo, no worktree"
            >
              <i className="ph ph-plus" />
            </button>
          </div>

          {!localCollapsed && (
            <GroupBody
              rows={localRows}
              archived={localArchived}
              emptyText="No local sessions. + opens a folder to work in."
              groupByFolder
              onDeleteFolder={onDeleteLocalFolder}
              {...rowProps}
            />
          )}
        </div>

        {repos.length === 0 && (
          <div className="sidebar__empty">No repos yet. Add one to start a session.</div>
        )}

        {repos.map((repo, index) => {
          const rows = groupRows(sessions, repo.id)
          const archived = sessions
            .filter((s) => s.repoId === repo.id && s.archived)
            .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
          return (
            <div
              className={`repo-group${dragged === repo.id ? ' is-lifted' : ''}${slot === index ? ' is-drop-before' : ''}${slot === repos.length && index === repos.length - 1 ? ' is-drop-after' : ''}`}
              key={repo.id}
              data-repo-id={repo.id}
            >
              <div
                className="repo-head"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', repo.id)
                  setDragged(repo.id)
                }}
                onDragEnd={endDrag}
              >
                <button
                  className="icon-btn-bare"
                  onClick={() => onToggleRepo(repo.id)}
                  aria-label={repo.collapsed ? 'Expand repo' : 'Collapse repo'}
                >
                  <i className={`ph ph-caret-down repo-head__caret${repo.collapsed ? ' is-collapsed' : ''}`} />
                </button>
                <span className="repo-head__name" data-tip={repo.path} data-tip-hint="Drag to reorder">
                  {repo.name}
                </span>
                <button
                  className="icon-btn-bare repo-head__remove"
                  onClick={() => onRemoveRepo(repo.id)}
                  aria-label={`Remove ${repo.name}`}
                  title="Remove repo from Maestro…"
                >
                  <i className="ph ph-trash" />
                </button>
                <button
                  className="icon-btn-bare"
                  onClick={() => onNewSession(repo.id)}
                  aria-label={`New session in ${repo.name}`}
                  title={`New session in ${repo.name}`}
                >
                  <i className="ph ph-plus" />
                </button>
              </div>

              {!repo.collapsed && (
                <GroupBody
                  rows={rows}
                  archived={archived}
                  emptyText="No sessions."
                  {...rowProps}
                />
              )}
            </div>
          )
        })}
      </div>

      <UpdateBar
        update={update}
        onUpdate={onUpdate}
        onUpdateCancel={onUpdateCancel}
        onUpdateLog={onUpdateLog}
      />

      <div className="sidebar__foot">
        {/* Sessions are created from a repo's own +, or Cmd+N — this slot adds repos. */}
        <button className="btn btn--block" onClick={onAddRepo}>
          <i className="ph ph-folder-plus" style={{ fontSize: 15 }} />
          Add repo
        </button>
        <button className="icon-btn-bare" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <i className="ph ph-gear" style={{ fontSize: 18 }} />
        </button>
        <button className="icon-btn-bare" onClick={onOpenAbout} aria-label="About" title="About">
          <i className="ph ph-info" style={{ fontSize: 18 }} />
        </button>
      </div>
    </aside>
  )
}
