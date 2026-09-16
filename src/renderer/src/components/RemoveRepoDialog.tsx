import { useEffect, useState } from 'react'
import type { ArchiveResult, RemoveRepoOptions, RemoveRepoPlan, WipPlan } from '@shared/types'
import { removalStep } from '@shared/removeRepo'
import Modal from './Modal'

interface RemoveRepoDialogProps {
  repoId: string
  repoName: string
  repoPath: string
  /** Sessions whose Claude is mid-turn — removing stops them, which is the part worth warning about. */
  busyCount: number
  onClose: () => void
  onRemove: (options: RemoveRepoOptions) => Promise<ArchiveResult>
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

/**
 * Hides a repo and its sessions, and optionally deletes what Maestro made for them — or the repo
 * folder itself, which takes everything. Counts come from the same per-session step main runs, so
 * what is confirmed is what happens.
 */
export default function RemoveRepoDialog({
  repoId,
  repoName,
  repoPath,
  busyCount,
  onClose,
  onRemove
}: RemoveRepoDialogProps): React.JSX.Element {
  const [plan, setPlan] = useState<RemoveRepoPlan | null>(null)
  const [deleteFolder, setDeleteFolder] = useState(false)
  const [removeWorktrees, setRemoveWorktrees] = useState(false)
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [allowForeign, setAllowForeign] = useState(false)
  const [wip, setWip] = useState<WipPlan>('leave')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.maestro.repos.removePlan(repoId).then(setPlan)
  }, [repoId])

  const options: RemoveRepoOptions = { removeWorktrees, deleteBranches, wip, allowForeign, deleteFolder }
  const all = plan?.sessions ?? []
  const steps = all.map((plan) => ({ plan, step: removalStep(plan, options) }))

  // What each checkbox would reach, so a box with nothing to act on is not offered.
  const ownedWorktrees = all.filter((p) => p.canRemoveWorktree && !p.worktreeIsForeign).length
  const foreignWorktrees = all.filter((p) => p.canRemoveWorktree && p.worktreeIsForeign).length
  const branchCandidates = all.filter(
    (p) => removalStep(p, { ...options, removeWorktrees: true, deleteBranches: true }).deletesBranch
  ).length

  const worktreeCount = steps.filter((s) => s.step.removesWorktree).length
  const branchCount = steps.filter((s) => s.step.deletesBranch).length
  const dirtyFiles = steps
    .filter((s) => s.step.removesWorktree)
    .reduce((sum, s) => sum + s.plan.dirtyCount, 0)
  const allDirty = all.reduce((sum, p) => sum + p.dirtyCount, 0)
  const needsWipChoice = !deleteFolder && dirtyFiles > 0 && wip === 'leave'

  // What only deleting the folder loses: nothing else holds these.
  const lost = plan
    ? [
        plan.folder.unpushedCommits > 0 &&
          `${plural(plan.folder.unpushedCommits, 'commit')} not on any remote`,
        plan.folder.stashes > 0 && plural(plan.folder.stashes, 'stash', 'stashes'),
        // Every session's, the clone's own included — nothing survives to hold them.
        plan.folder.dirtyFiles + allDirty > 0 &&
          plural(plan.folder.dirtyFiles + allDirty, 'uncommitted file')
      ].filter((fact): fact is string => Boolean(fact))
    : []

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await onRemove(options)
    setBusy(false)
    if (result.ok) return onClose()
    setError(result.error ?? 'Failed.')
    // Some sessions may already be done, so the counts are read again.
    void window.maestro.repos.removePlan(repoId).then(setPlan)
  }

  return (
    <Modal onClose={onClose} width={540} label="Remove repo">
      <div className="modal__title">
        {deleteFolder ? 'Delete' : 'Remove'} “{repoName}”?
      </div>
      <div className="modal__sub">{repoPath}</div>

      {plan === null ? (
        <div className="launcher__empty">Checking what this would do…</div>
      ) : (
        <>
          <div className="field">
            <label>Afterwards</label>
            <div className="outcome">
              <div className="outcome__row">
                <span className="outcome__where">repo</span>
                <span className="outcome__what">
                  {deleteFolder ? (
                    <>
                      <b style={{ color: 'var(--status-del)' }}>deleted</b> — {repoPath}
                    </>
                  ) : (
                    <>
                      <b>kept</b> — hidden from Maestro until you add it again
                    </>
                  )}
                </span>
              </div>
              {deleteFolder && (
                <div className="outcome__row">
                  <span className="outcome__where">lost</span>
                  <span className="outcome__what">
                    {lost.length > 0 ? (
                      <b style={{ color: 'var(--status-del)' }}>{lost.join(', ')}</b>
                    ) : (
                      'nothing unpushed or uncommitted'
                    )}
                  </span>
                </div>
              )}
              {deleteFolder && all.length > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">sessions</span>
                  <span className="outcome__what">
                    <b>deleted</b> — {plural(all.length, 'session')}
                  </span>
                </div>
              )}
              {!deleteFolder && all.length > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">sessions</span>
                  <span className="outcome__what">
                    {branchCount > 0 ? (
                      <>
                        <b>{`${branchCount} deleted`}</b> with their branch, the rest come back
                        with the repo
                      </>
                    ) : (
                      <>
                        <b>hidden</b> — {plural(all.length, 'session')} come back with the repo
                      </>
                    )}
                  </span>
                </div>
              )}
              {ownedWorktrees + foreignWorktrees > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">worktrees</span>
                  <span className="outcome__what">
                    {worktreeCount > 0 ? (
                      <>
                        <b>{`${worktreeCount} deleted`}</b>
                        {worktreeCount < ownedWorktrees + foreignWorktrees &&
                          `, ${ownedWorktrees + foreignWorktrees - worktreeCount} kept`}
                      </>
                    ) : (
                      <b>kept</b>
                    )}
                  </span>
                </div>
              )}
              {!deleteFolder && branchCandidates > 0 && (
                <div className="outcome__row">
                  <span className="outcome__where">branches</span>
                  <span className="outcome__what">
                    {branchCount > 0 ? <b>{`${branchCount} deleted`}</b> : <b>kept</b>}
                  </span>
                </div>
              )}
            </div>
          </div>

          {!deleteFolder && ownedWorktrees > 0 && (
            <button className="checkbox" onClick={() => setRemoveWorktrees((v) => !v)}>
              <span className={`checkbox__box${removeWorktrees ? ' is-on' : ''}`}>
                {removeWorktrees && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                Also delete the {plural(ownedWorktrees, 'worktree')} Maestro created
              </span>
            </button>
          )}

          {!deleteFolder && removeWorktrees && foreignWorktrees > 0 && (
            <button className="checkbox checkbox--warn" onClick={() => setAllowForeign((v) => !v)}>
              <span className={`checkbox__box${allowForeign ? ' is-on' : ''}`}>
                {allowForeign && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                <i className="ph ph-warning" /> Also delete {plural(foreignWorktrees, 'worktree')}{' '}
                Maestro did not create. Maestro cannot rebuild them.
              </span>
            </button>
          )}

          {!deleteFolder && removeWorktrees && branchCandidates > 0 && (
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

          {plan.folder.canDelete ? (
            <button className="checkbox checkbox--warn" onClick={() => setDeleteFolder((v) => !v)}>
              <span className={`checkbox__box${deleteFolder ? ' is-on' : ''}`}>
                {deleteFolder && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                <i className="ph ph-warning" /> Delete the repo folder too. Every branch, stash and
                unpushed commit goes with it.
              </span>
            </button>
          ) : (
            <div className="modal__note">Can’t delete the repo folder: {plan.folder.refusal}.</div>
          )}

          {!deleteFolder && dirtyFiles > 0 && (
            <div className="field">
              <label>
                {plural(dirtyFiles, 'uncommitted file')} — what happens to{' '}
                {dirtyFiles === 1 ? 'it' : 'them'}?
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
              {wip !== 'leave' && (
                <span
                  className="modal__note"
                  style={{ color: wip === 'discard' ? 'var(--status-del)' : undefined }}
                >
                  {WIP_NOTE[wip]}
                </span>
              )}
            </div>
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
          disabled={busy || needsWipChoice || plan === null}
        >
          {busy ? <span className="spinner" /> : <i className="ph ph-trash" style={{ fontSize: 15 }} />}
          {deleteFolder ? 'Delete repo' : 'Remove'}
        </button>
      </div>
    </Modal>
  )
}
