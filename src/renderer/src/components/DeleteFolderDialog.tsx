import { useEffect, useState } from 'react'
import type { ArchiveResult, LocalFolderPlan } from '@shared/types'
import Modal from './Modal'

interface DeleteFolderDialogProps {
  path: string
  name: string
  home: string
  /** Sessions whose Claude is mid-turn — deleting stops them. */
  busyCount: number
  onClose: () => void
  onDelete: (deleteFolder: boolean) => Promise<ArchiveResult>
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Deletes every session sharing a local folder, and the folder itself when ticked. */
export default function DeleteFolderDialog({
  path,
  name,
  home,
  busyCount,
  onClose,
  onDelete
}: DeleteFolderDialogProps): React.JSX.Element {
  const [plan, setPlan] = useState<LocalFolderPlan | null>(null)
  const [deleteFolder, setDeleteFolder] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.maestro.sessions.folderPlan(path).then(setPlan)
  }, [path])

  const short = path.startsWith(home) ? `~${path.slice(home.length)}` : path

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await onDelete(deleteFolder && (plan?.canDeleteFolder ?? false))
    setBusy(false)
    if (result.ok) return onClose()
    setError(result.error ?? 'Failed.')
    void window.maestro.sessions.folderPlan(path).then(setPlan)
  }

  return (
    <Modal onClose={onClose} width={500} label="Delete folder sessions">
      <div className="modal__title">Delete the sessions in “{name}”?</div>
      <div className="modal__sub">{short}</div>

      {plan === null ? (
        <div className="launcher__empty">Checking what this would do…</div>
      ) : (
        <>
          <div className="field">
            <label>Afterwards</label>
            <div className="outcome">
              <div className="outcome__row">
                <span className="outcome__where">sessions</span>
                <span className="outcome__what">
                  <b>removed</b> — {plural(plan.sessionIds.length, 'session')}
                  {deleteFolder && plan.archivedIds.length > 0 &&
                    `, and ${plan.archivedIds.length} archived`}
                </span>
              </div>
              <div className="outcome__row">
                <span className="outcome__where">folder</span>
                <span className="outcome__what">
                  {deleteFolder ? (
                    <b style={{ color: 'var(--status-del)' }}>deleted</b>
                  ) : (
                    <b>kept</b>
                  )}{' '}
                  — {short} and everything in it
                </span>
              </div>
            </div>
          </div>

          {plan.canDeleteFolder ? (
            <button className="checkbox checkbox--warn" onClick={() => setDeleteFolder((v) => !v)}>
              <span className={`checkbox__box${deleteFolder ? ' is-on' : ''}`}>
                {deleteFolder && <i className="ph ph-check" />}
              </span>
              <span className="checkbox__label">
                <i className="ph ph-warning" /> Also delete the folder and everything in it
                {plan.madeByMaestro ? '' : '. Maestro did not create it'}. Nothing to recover.
              </span>
            </button>
          ) : (
            <div className="modal__note">Can’t delete the folder: {plan.folderRefusal}.</div>
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
          disabled={busy || plan === null}
        >
          {busy ? <span className="spinner" /> : <i className="ph ph-trash" style={{ fontSize: 15 }} />}
          Delete
        </button>
      </div>
    </Modal>
  )
}
