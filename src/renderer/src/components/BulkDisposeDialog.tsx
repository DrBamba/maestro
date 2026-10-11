import { useEffect, useState } from 'react'
import type {
  ArchivePlan,
  DisposeAction,
  DisposeOptions,
  LocalFolderPlan,
  WipPlan
} from '@shared/types'
import Modal from './Modal'

interface BulkDisposeDialogProps {
  sessions: { id: string; name: string }[]
  home: string
  initialAction: DisposeAction
  /** Sessions whose Claude is mid-turn — disposing stops them. */
  busyCount: number
  onClose: () => void
  /** Runs one session at a time and reports the ones that failed, which stay selected. */
  onDispose: (
    jobs: { id: string; options: DisposeOptions }[],
    action: DisposeAction
  ) => Promise<{ ok: boolean; error?: string }>
}

const WIP_LABEL: Record<Exclude<WipPlan, 'leave'>, string> = {
  commit: 'Commit them',
  stash: 'Stash them',
  discard: 'Discard them'
}

const WIP_NOTE: Record<Exclude<WipPlan, 'leave'>, string> = {
  commit: 'Committed to each branch.',
  stash: 'Kept in the repo’s stash. Restoring a session puts them back.',
  discard: 'Thrown away — nothing to recover.'
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A local folder the selection could delete, or the reason it cannot. */
interface FolderChoice {
  plan: LocalFolderPlan
  /** Selected sessions working in it, in the order they will go. */
  members: string[]
  refusal?: string
}

/**
 * The single-session dialog's choices, asked once for a whole selection. Each session's own plan
 * decides what actually happens to it — an option only narrows, so a foreign worktree is still
 * spared without the explicit tick.
 *
 * A local folder can go only when every session in it is selected. Its sessions are deleted
 * together and the last of them takes the folder: main refuses the folder while any other session
 * still works in it.
 */
export default function BulkDisposeDialog({
  sessions,
  home,
  initialAction,
  busyCount,
  onClose,
  onDispose
}: BulkDisposeDialogProps): React.JSX.Element {
  const [plans, setPlans] = useState<ArchivePlan[] | null>(null)
  const [folderPlans, setFolderPlans] = useState<LocalFolderPlan[]>([])
  const [deleteFolders, setDeleteFolders] = useState(false)
  const [action, setAction] = useState<DisposeAction>(initialAction)
  const [wip, setWip] = useState<WipPlan>('leave')
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [hardDelete, setHardDelete] = useState(false)
  const [allowForeign, setAllowForeign] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ids = sessions.map((s) => s.id).join('\n')
  useEffect(() => {
    setPlans(null)
    void Promise.all(ids.split('\n').map((id) => window.maestro.sessions.archivePlan(id))).then(
      (next) => {
        const found = next.filter((p): p is ArchivePlan => p !== null)
        const dirs = [...new Set(found.filter((p) => p.isLocal).map((p) => p.worktreePath))]
        void Promise.all(dirs.map((dir) => window.maestro.sessions.folderPlan(dir))).then((folders) => {
          setFolderPlans(folders)
          setPlans(found)
        })
        if (found.every((p) => p.archived)) setAction('delete')
      }
    )
  }, [ids])

  const all = plans ?? []
  const allArchived = all.length > 0 && all.every((p) => p.archived)
  // Nothing is archived twice, so an archived session sits an archive out.
  const targets = action === 'archive' ? all.filter((p) => !p.archived) : all
  const skipped = all.length - targets.length

  const worktreeForeign = (p: ArchivePlan): boolean => p.worktreeIsForeign && !p.worktreeGone
  const removesWorktree = (p: ArchivePlan): boolean =>
    p.canRemoveWorktree && (!worktreeForeign(p) || allowForeign)
  const deletesBranch = (p: ArchivePlan): boolean =>
    action === 'delete' && deleteBranches && p.canDeleteBranch && (!p.branchIsForeign || allowForeign)

  const repoTargets = targets.filter((p) => !p.isLocal)
  const liveWorktrees = repoTargets.filter((p) => !p.worktreeGone).length
  const worktreeCount = targets.filter(removesWorktree).length
  const branchCandidates = action === 'delete' ? targets.filter((p) => p.canDeleteBranch).length : 0
  const branchCount = targets.filter(deletesBranch).length
  const foreignCount = targets.filter(
    (p) =>
      !p.isPrimaryClone &&
      (worktreeForeign(p) || (action === 'delete' && deleteBranches && p.branchIsForeign && p.canDeleteBranch))
  ).length
  // Main refuses any dirty session it could remove, whether or not this run removes it.
  const dirty = targets.filter((p) => p.dirtyCount > 0 && p.canRemoveWorktree)
  const dirtyFiles = dirty.reduce((sum, p) => sum + p.dirtyCount, 0)
  const needsWipChoice = dirtyFiles > 0 && wip === 'leave'
  const short = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  const picked = new Set(sessions.map((s) => s.id))
  const folders: FolderChoice[] =
    action === 'delete'
      ? folderPlans.map((plan) => {
          const members = targets.filter((p) => p.worktreePath === plan.path).map((p) => p.sessionId)
          const left = [...plan.sessionIds, ...plan.archivedIds].find((id) => !picked.has(id))
          const refusal = !plan.canDeleteFolder
            ? plan.folderRefusal
            : left
              ? 'select every session in it first'
              : undefined
          return { plan, members, refusal }
        })
      : []
  const deletable = folders.filter((f) => !f.refusal)
  const folderCount = targets.some((p) => p.isLocal)
    ? new Set(targets.filter((p) => p.isLocal).map((p) => p.worktreePath)).size
    : 0
  const foldersGoing = deleteFolders ? deletable.length : 0
  const stashes = action === 'delete' ? targets.filter((p) => p.archivedStash).length : 0

  const names = sessions.map((s) => `“${s.name}”`)
  const sub = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const options = (p: ArchivePlan, deleteFolder: boolean): DisposeOptions => ({
      action,
      wip: p.dirtyCount > 0 ? wip : 'leave',
      deleteBranch: action === 'delete' && deleteBranches,
      hardDelete,
      allowForeign,
      deleteFolder
    })
    // Each going folder's sessions run last and together, the final one carrying the folder.
    const going = deleteFolders ? deletable : []
    const grouped = new Set(going.flatMap((f) => f.members))
    const jobs = [
      ...targets.filter((p) => !grouped.has(p.sessionId)).map((p) => ({ id: p.sessionId, options: options(p, false) })),
      ...going.flatMap((f) =>
        f.members.map((id, i) => ({
          id,
          options: options(targets.find((p) => p.sessionId === id)!, i === f.members.length - 1)
        }))
      )
    ]
    const result = await onDispose(jobs, action)
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error ?? 'Failed.')
  }

  return (
    <Modal onClose={onClose} width={540} label="Archive or delete sessions">
      <div className="modal__title">
        {allArchived ? `Delete ${plural(sessions.length, 'archived session')}?` : plural(sessions.length, 'session')}
      </div>
      <div className="modal__sub">{sub}</div>

      {!allArchived && (
        <div className="seg seg--lg" role="group" aria-label="Action">
          <button
            className={`seg__opt${action === 'archive' ? ' is-on' : ''}`}
            onClick={() => setAction('archive')}
          >
            Archive
          </button>
          <button
            className={`seg__opt${action === 'delete' ? ' is-on' : ''}`}
            onClick={() => setAction('delete')}
          >
            Delete
          </button>
        </div>
      )}

      {plans === null ? (
        <div className="launcher__empty">Checking what this would do…</div>
      ) : (
        <>
          <div className="field">
            <label>Afterwards</label>
            <div className="outcome">
              <div className="outcome__row">
                <span className="outcome__where">sessions</span>
                <span className="outcome__what">
                  {action === 'archive' ? (
                    <>
                      <b>{plural(targets.length, 'archived', 'archived')}</b> — restorable from the
                      sidebar{skipped > 0 && `; ${skipped} already archived`}
                    </>
                  ) : (
                    <>
                      <b>{plural(targets.length, 'removed', 'removed')}</b> — not reversible
                    </>
                  )}
                </span>
              </div>
              {liveWorktrees > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">worktrees</span>
                  <span className="outcome__what">
                    {worktreeCount > 0 ? (
                      <>
                        <b>{`${worktreeCount} deleted`}</b>
                        {worktreeCount < liveWorktrees && `, ${liveWorktrees - worktreeCount} kept`}
                      </>
                    ) : (
                      <b>kept</b>
                    )}
                  </span>
                </div>
              )}
              {action === 'delete' && repoTargets.length > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">branches</span>
                  <span className="outcome__what">
                    {branchCount > 0 ? (
                      <>
                        <b>{`${branchCount} deleted`}</b>
                        {branchCount < repoTargets.length && `, ${repoTargets.length - branchCount} kept`}
                      </>
                    ) : (
                      <b>kept</b>
                    )}
                  </span>
                </div>
              )}
              {folderCount > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">folders</span>
                  <span className="outcome__what">
                    {foldersGoing > 0 ? (
                      <>
                        <b style={{ color: 'var(--status-del)' }}>{`${foldersGoing} deleted`}</b>
                        {foldersGoing < folderCount && `, ${folderCount - foldersGoing} kept`} — and
                        everything in them
                      </>
                    ) : (
                      <>
                        <b>kept</b> — local folders and everything in them
                      </>
                    )}
                  </span>
                </div>
              )}
              {stashes > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">stash</span>
                  <span className="outcome__what">
                    <b>kept</b> — still in{' '}
                    <span style={{ fontFamily: 'var(--font-mono)' }}>git stash list</span>
                  </span>
                </div>
              )}
            </div>
          </div>

          {dirtyFiles > 0 && (
            <div className="field">
              <label>
                {plural(dirtyFiles, 'uncommitted file')} in {plural(dirty.length, 'session')} — what
                happens to {dirtyFiles === 1 ? 'it' : 'them'}?
              </label>
              <div className="seg" role="group" aria-label="Uncommitted work">
                {(['commit', 'stash', 'discard'] as const).map((option) => (
                  <button
                    key={option}
                    className={`seg__opt${wip === option ? ' is-on' : ''}`}
                    onClick={() => setWip(option)}
                  >
                    {WIP_LABEL[option]}
                  </button>
                ))}
              </div>
              {wip !== 'leave' ? (
                <span
                  className="modal__note"
                  style={{ color: wip === 'discard' ? 'var(--status-del)' : undefined }}
                >
                  {WIP_NOTE[wip]}
                </span>
              ) : (
                <span className="modal__note">Pick one to continue, or cancel.</span>
              )}
            </div>
          )}

          {foreignCount > 0 && (
            <button className="checkbox checkbox--warn" onClick={() => setAllowForeign((v) => !v)}>
              <span className={`checkbox__box${allowForeign ? ' is-on' : ''}`}>
                {allowForeign && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                <i className="ph ph-warning" /> Maestro did not create {foreignCount === 1 ? 'one' : foreignCount}{' '}
                of these. Remove {foreignCount === 1 ? 'it' : 'them'} anyway — Maestro cannot rebuild{' '}
                {foreignCount === 1 ? 'it' : 'them'}.
              </span>
            </button>
          )}

          {deletable.length > 0 && (
            <button className="checkbox checkbox--warn" onClick={() => setDeleteFolders((v) => !v)}>
              <span className={`checkbox__box${deleteFolders ? ' is-on' : ''}`}>
                {deleteFolders && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                <i className="ph ph-warning" /> Also delete{' '}
                {deletable.length === 1 ? 'the folder' : plural(deletable.length, 'folder')} and
                everything in {deletable.length === 1 ? 'it' : 'them'}
                {deletable.some((f) => !f.plan.madeByMaestro) &&
                  `. Maestro did not create ${deletable.length === 1 ? 'it' : 'all of them'}`}
                . Nothing to recover.
              </span>
            </button>
          )}

          {folders
            .filter((f) => f.refusal)
            .map((f) => (
              <div className="modal__note" key={f.plan.path} title={short(f.plan.path)}>
                Can’t delete “{f.plan.path.replace(/\/+$/, '').split('/').pop()}”: {f.refusal}.
              </div>
            ))}

          {branchCandidates > 0 && (
            <button className="checkbox" onClick={() => setDeleteBranches((v) => !v)}>
              <span className={`checkbox__box${deleteBranches ? ' is-on' : ''}`}>
                {deleteBranches && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                Also delete their {plural(branchCandidates, 'branch', 'branches')} — commits go with
                them
              </span>
            </button>
          )}

          {worktreeCount > 0 && (
            <button className="checkbox" onClick={() => setHardDelete((v) => !v)}>
              <span className={`checkbox__box${hardDelete ? ' is-on' : ''}`}>
                {hardDelete && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                If git refuses, fall back to{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>rm -rf</span>
              </span>
            </button>
          )}

          {busyCount > 0 && (
            <div className="modal__note" style={{ color: 'var(--status-del)' }}>
              Claude is working in {plural(busyCount, 'session')} and will be stopped.
            </div>
          )}
        </>
      )}

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={busy || needsWipChoice || plans === null || targets.length === 0}
        >
          {busy ? (
            <span className="spinner" />
          ) : (
            <i className={`ph ${action === 'archive' ? 'ph-archive' : 'ph-trash'}`} style={{ fontSize: 15 }} />
          )}
          {action === 'archive' ? 'Archive' : 'Delete'} {targets.length}
        </button>
      </div>
    </Modal>
  )
}
