import { useEffect, useState } from 'react'
import type { CheckState, PrResult, PrStatus } from '@shared/types'
import Modal from './Modal'
import { defaultPrTitle } from '../lib/format'

interface PrDialogProps {
  sessionId: string
  sessionName: string
  branch: string
  defaultBranch: string
  remote: string | null
  ghAvailable: boolean
  fileCount: number
  onClose: () => void
  onCreate: (title: string, body: string) => Promise<PrResult>
}

const CHECK_LABEL: Record<CheckState, string> = {
  passed: 'passed',
  failed: 'failed',
  pending: 'running',
  none: 'no status'
}

export default function PrDialog({
  sessionId,
  sessionName,
  branch,
  defaultBranch,
  remote,
  ghAvailable,
  fileCount,
  onClose,
  onCreate
}: PrDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(defaultPrTitle(sessionName))
  const [body, setBody] = useState(
    `Session: ${sessionName}\n\n${fileCount} file${fileCount === 1 ? '' : 's'} changed on \`${branch}\`.`
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<PrStatus | null>(null)

  // If a PR already exists for this branch, show its checks instead of pretending it does not.
  useEffect(() => {
    if (!ghAvailable) return
    void window.maestro.git.prStatus(sessionId).then(setStatus)
  }, [sessionId, ghAvailable])

  const submit = async (): Promise<void> => {
    if (busy || !title.trim()) return
    setBusy(true)
    setError(null)
    const result = await onCreate(title.trim(), body)
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.message)
  }

  return (
    <Modal onClose={onClose} width={520} label="Create pull request">
      <div className="modal__title">Create pull request</div>
      <div className="modal__sub">
        {branch} → {defaultBranch}
        {remote ? ` · github.com/${remote}` : ''}
      </div>

      {!ghAvailable && (
        <div className="modal__error">
          `gh` is not installed. Run `brew install gh` and `gh auth login`, then try again.
        </div>
      )}

      <div className="field">
        <label htmlFor="pr-title">Title</label>
        <input
          id="pr-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="pr-body">Description</label>
        <textarea
          id="pr-body"
          className="input textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {status && status.checks.length > 0 && (
        <div className="checks">
          {status.checks.slice(0, 4).map((check) => (
            <span className="check" key={check.name}>
              <span className={`check__dot is-${check.state}`} />
              {check.name} {CHECK_LABEL[check.state]}
            </span>
          ))}
        </div>
      )}

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={busy || !ghAvailable || !title.trim()}
        >
          {busy ? (
            <span className="spinner" />
          ) : (
            <i className="ph ph-git-pull-request" style={{ fontSize: 15 }} />
          )}
          Create PR
        </button>
      </div>
    </Modal>
  )
}
