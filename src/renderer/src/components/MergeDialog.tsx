import { useState } from 'react'
import type { GitStatus, MergeMode, MergeResult } from '@shared/types'
import Modal from './Modal'

interface MergeDialogProps {
  branch: string
  defaultBranch: string
  status: GitStatus | null
  commitCount: number
  onClose: () => void
  onMerge: (mode: MergeMode, archiveAfter: boolean) => Promise<MergeResult>
  onOpenConflicts: (paths: string[]) => void
  onHandToClaude: (paths: string[]) => void
}

export default function MergeDialog({
  branch,
  defaultBranch,
  status,
  commitCount,
  onClose,
  onMerge,
  onOpenConflicts,
  onHandToClaude
}: MergeDialogProps): React.JSX.Element {
  // Rebase is the default: it keeps the session's work linear on top of the base branch.
  const [mode, setMode] = useState<MergeMode>('rebase')
  const [archiveAfter, setArchiveAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await onMerge(mode, archiveAfter)
    setBusy(false)
    if (r.ok) onClose()
    else setResult(r)
  }

  const conflicts = result?.conflicts ?? []

  return (
    <Modal onClose={onClose} width={480} label={`Merge into ${defaultBranch}`}>
      <div className="modal__title">Merge into {defaultBranch}</div>
      <div className="modal__sub">
        {branch} · {commitCount} commit{commitCount === 1 ? '' : 's'}, {status?.files.length ?? 0}{' '}
        file{(status?.files.length ?? 0) === 1 ? '' : 's'}
      </div>

      <div className="seg seg--lg" role="group" aria-label="Integration mode">
        <button
          className={`seg__opt${mode === 'rebase' ? ' is-on' : ''}`}
          onClick={() => setMode('rebase')}
        >
          Rebase
        </button>
        <button
          className={`seg__opt${mode === 'merge' ? ' is-on' : ''}`}
          onClick={() => setMode('merge')}
        >
          Merge commit
        </button>
      </div>

      <button className="checkbox" onClick={() => setArchiveAfter((v) => !v)}>
        <span className={`checkbox__box${archiveAfter ? ' is-on' : ''}`}>
          {archiveAfter && <i className="ph ph-check" />}
        </span>
        <span className="checkbox__label">Archive worktree and branch after merge</span>
      </button>

      {conflicts.length === 0 ? (
        <div className="modal__note">
          Conflicts open in the embedded editor — or hand them to Claude to resolve.
        </div>
      ) : (
        <>
          <div className="modal__error">
            {result?.message}. The worktree is left mid-{mode} so you can resolve it.
          </div>
          <div className="modal__note" style={{ maxHeight: 96, overflowY: 'auto' }}>
            {conflicts.map((path) => (
              <div key={path} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {path}
              </div>
            ))}
          </div>
          <div className="git__actions">
            <button className="btn btn--small btn--block" onClick={() => onOpenConflicts(conflicts)}>
              <i className="ph ph-code" style={{ fontSize: 14 }} />
              Open in editor
            </button>
            <button className="btn btn--small btn--block" onClick={() => onHandToClaude(conflicts)}>
              <i className="ph ph-terminal-window" style={{ fontSize: 14 }} />
              Hand to Claude
            </button>
          </div>
        </>
      )}

      {result && !result.ok && conflicts.length === 0 && (
        <div className="modal__error">{result.message}</div>
      )}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => void run()} disabled={busy}>
          {busy ? <span className="spinner" /> : <i className="ph ph-arrows-merge" style={{ fontSize: 15 }} />}
          {mode === 'rebase' ? `Rebase onto ${defaultBranch}` : `Merge into ${defaultBranch}`}
        </button>
      </div>
    </Modal>
  )
}
