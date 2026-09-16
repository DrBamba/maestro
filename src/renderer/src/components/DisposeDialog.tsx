import { useEffect, useState } from 'react'
import type { ArchivePlan, DisposeAction, DisposeOptions, WipPlan } from '@shared/types'
import Modal from './Modal'

interface DisposeDialogProps {
  sessionId: string
  sessionName: string
  home: string
  /**
   * Which action the dialog opens on; both remain switchable — except for a session that is already
   * archived, where delete is the only one left.
   */
  initialAction: DisposeAction
  onClose: () => void
  onDispose: (options: DisposeOptions) => Promise<{ ok: boolean; error?: string }>
}

const WIP_LABEL: Record<Exclude<WipPlan, 'leave'>, string> = {
  commit: 'Commit them',
  stash: 'Stash them',
  discard: 'Discard them'
}

const WIP_NOTE: Record<Exclude<WipPlan, 'leave'>, string> = {
  commit: 'Committed to the branch — kept either way.',
  stash: 'Kept in the repo’s stash. Restoring the session puts them back.',
  discard: 'Thrown away — nothing to recover.'
}

/**
 * Archive and delete differ in what survives, so they share one dialog rather than hiding the
 * difference behind two similar buttons. Uncommitted work must be dealt with explicitly — the
 * confirm button stays disabled until a choice is made, because the old single-click path used
 * `--force` and destroyed it silently.
 *
 * An already-archived session comes through here too, so "what survives" is answered in one place
 * for both steps of the journey — the worktree it lost, and the branch and record it still has.
 */
export default function DisposeDialog({
  sessionId,
  sessionName,
  home,
  initialAction,
  onClose,
  onDispose
}: DisposeDialogProps): React.JSX.Element {
  const [plan, setPlan] = useState<ArchivePlan | null>(null)
  const [action, setAction] = useState<DisposeAction>(initialAction)
  const [wip, setWip] = useState<WipPlan>('leave')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [hardDelete, setHardDelete] = useState(false)
  const [allowForeign, setAllowForeign] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.maestro.sessions.archivePlan(sessionId).then((next) => {
      setPlan(next)
      // Nothing can be archived twice, whichever action the caller opened on.
      if (next?.archived) setAction('delete')
    })
  }, [sessionId])

  const dirty = (plan?.dirtyCount ?? 0) > 0
  // A worktree that is already gone needs no acknowledgement, whoever made it: there is nothing
  // left to remove, so the warning would be about a step that will not run.
  const worktreeForeign = (plan?.worktreeIsForeign ?? false) && !(plan?.worktreeGone ?? false)
  // A foreign worktree is removable, but only once acknowledged.
  const foreignBlocked = worktreeForeign && !allowForeign
  const removesWorktree = (plan?.canRemoveWorktree ?? false) && !foreignBlocked
  // Only a removal can destroy the working tree, so only then must WIP be settled.
  const needsWipChoice = dirty && removesWorktree && wip === 'leave'
  const short = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await onDispose({
      action,
      wip: dirty ? wip : 'leave',
      deleteBranch: action === 'delete' && deleteBranch,
      hardDelete,
      allowForeign
    })
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error ?? 'Failed.')
  }

  return (
    <Modal
      onClose={onClose}
      width={540}
      label={plan?.archived ? 'Delete archived session' : 'Archive or delete session'}
    >
      <div className="modal__title">“{sessionName}”</div>
      <div className="modal__sub">{plan ? short(plan.worktreePath) : ''}</div>

      {/* Already archived: archiving again is not a choice, so the only action is stated, not offered. */}
      {plan?.archived ? (
        <div className="modal__note">
          Already archived. Deleting removes what archiving kept, and is not reversible.
        </div>
      ) : (
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

      {plan === null ? (
        <div className="launcher__empty">Checking what this would do…</div>
      ) : (
        <>
          <div className="field">
            <label>Afterwards</label>
            <div className="outcome">
              {/*
                * Nothing about a local session was Maestro's to make, so nothing is Maestro's to
                * remove. The folder is stated as kept rather than left out, because "delete" on a
                * directory full of your own files is exactly the fear worth answering.
                */}
              {plan.isLocal ? (
                <div className="outcome__row">
                  <span className="outcome__where">folder</span>
                  <span className="outcome__what">
                    <b>kept</b> — {short(plan.worktreePath)} and everything in it
                  </span>
                </div>
              ) : (
                <>
                  <div className="outcome__row">
                    <span className="outcome__where">worktree</span>
                    <span className="outcome__what">
                      {removesWorktree ? (
                        <>
                          <b>deleted</b> — {short(plan.worktreePath)}
                        </>
                      ) : plan.worktreeGone ? (
                        <>
                          <b>already gone</b> — {plan.archived ? 'archiving removed it' : 'nothing there to remove'}
                        </>
                      ) : plan.isPrimaryClone ? (
                        <>
                          <b>kept</b> — git cannot remove a primary clone
                        </>
                      ) : (
                        <>
                          <b>kept</b> — tick below to remove it anyway
                        </>
                      )}
                    </span>
                  </div>
                  <div className="outcome__row">
                    <span className="outcome__where">branch</span>
                    <span className="outcome__what">
                      {action === 'delete' && deleteBranch && plan.canDeleteBranch ? (
                        <>
                          <b>deleted</b> — {plan.branch}
                        </>
                      ) : (
                        <>
                          <b>kept</b> — {plan.branch}
                        </>
                      )}
                    </span>
                  </div>
                </>
              )}
              {/*
                * Where the uncommitted work went. Delete does not drop the stash: a stash is not
                * rebuildable, and "not reversible" should be about the session, not about work the
                * user asked to keep when they archived.
                */}
              {plan.archivedStash && (
                <div className="outcome__row">
                  <span className="outcome__where">stash</span>
                  <span className="outcome__what">
                    <b>kept</b> — still in{' '}
                    <span style={{ fontFamily: 'var(--font-mono)' }}>git stash list</span>
                  </span>
                </div>
              )}
              <div className="outcome__row">
                <span className="outcome__where">session</span>
                <span className="outcome__what">
                  {action === 'archive' ? (
                    plan.restorable ? (
                      <>
                        <b>archived</b> — restorable from the sidebar
                      </>
                    ) : (
                      <>
                        <b>archived</b> — hidden from the sidebar
                      </>
                    )
                  ) : (
                    <>
                      <b>removed</b> — not reversible
                    </>
                  )}
                </span>
              </div>
            </div>
          </div>

          {plan.notes.map((note) => (
            <div className="modal__note" key={note}>
              {note}
            </div>
          ))}

          {dirty && removesWorktree && (
            <div className="field">
              <label>
                {plan.dirtyCount} uncommitted file{plan.dirtyCount === 1 ? '' : 's'} — what happens
                to {plan.dirtyCount === 1 ? 'it' : 'them'}?
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
              {needsWipChoice && (
                <span className="modal__note">Pick one to continue, or cancel.</span>
              )}
            </div>
          )}

          {(worktreeForeign || (action === 'delete' && plan.branchIsForeign)) &&
            !plan.isPrimaryClone && (
              <button className="checkbox checkbox--warn" onClick={() => setAllowForeign((v) => !v)}>
                <span className={`checkbox__box${allowForeign ? ' is-on' : ''}`}>
                  {allowForeign && <i className="ph ph-check" />}
                </span>
                <span className="checkbox__label">
                  <i className="ph ph-warning" /> Maestro did not create{' '}
                  {worktreeForeign && plan.branchIsForeign && action === 'delete'
                    ? 'this worktree or branch'
                    : worktreeForeign
                      ? 'this worktree'
                      : 'this branch'}
                  . Remove it anyway — Maestro cannot rebuild it.
                </span>
              </button>
            )}

          {action === 'delete' && plan.canDeleteBranch && (
            <button className="checkbox" onClick={() => setDeleteBranch((v) => !v)}>
              <span className={`checkbox__box${deleteBranch ? ' is-on' : ''}`}>
                {deleteBranch && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                Also delete the branch{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{plan.branch}</span> — its commits
                go with it
                {plan.branchIsForeign && !allowForeign && ' (needs the box above)'}
              </span>
            </button>
          )}

          {removesWorktree && (
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
          {busy ? (
            <span className="spinner" />
          ) : (
            <i className={`ph ${action === 'archive' ? 'ph-archive' : 'ph-trash'}`} style={{ fontSize: 15 }} />
          )}
          {action === 'archive' ? 'Archive' : 'Delete'}
        </button>
      </div>
    </Modal>
  )
}
