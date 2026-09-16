import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'

interface RenameDialogProps {
  sessionName: string
  branch: string
  onClose: () => void
  onRename: (name: string) => Promise<void>
}

/**
 * Renames the session's label only.
 *
 * The branch and the worktree directory are fixed when the session is created — the branch may
 * already have commits on it and the directory may be open in an editor or a shell — so this
 * deliberately does not try to keep them in step, and says so rather than leaving the mismatch to
 * be discovered.
 */
export default function RenameDialog({
  sessionName,
  branch,
  onClose,
  onRename
}: RenameDialogProps): React.JSX.Element {
  const [name, setName] = useState(sessionName)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    await onRename(trimmed)
    onClose()
  }

  return (
    <Modal onClose={onClose} width={440} label="Rename session">
      <div className="modal__title">Rename session</div>

      <div className="field">
        <label htmlFor="rename-input">Name</label>
        <input
          id="rename-input"
          ref={inputRef}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </div>

      <div className="modal__note">
        Changes the label only. The branch stays{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-neutral-400)' }}>
          {branch}
        </span>{' '}
        and the worktree keeps its path, since both may already be in use.
      </div>

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
          <i className="ph ph-check" style={{ fontSize: 15 }} />
          Rename
        </button>
      </div>
    </Modal>
  )
}
