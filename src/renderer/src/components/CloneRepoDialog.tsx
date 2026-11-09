import { useEffect, useRef, useState } from 'react'
import { homeRelative } from '../lib/format'
import Modal from './Modal'

interface CloneRepoDialogProps {
  home: string
  /** Where the folder field starts: beside the repos already added, where clones usually live. */
  defaultParent: string
  onClose: () => void
  onClone: (source: string, parent: string, login: string | null) => Promise<string | null>
}

/** Same rule as main's `cloneName`, for showing where the clone will land before it exists. */
function cloneName(source: string): string {
  return (
    source
      .trim()
      .replace(/[/:]+$/, '')
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '') ?? ''
  )
}

/**
 * Clones a repo and adds it, recording the account it was cloned as. That account is the repo's
 * from then on: pushes, `gh`, and the `GH_TOKEN` of every session started in it.
 *
 * The folder is a text field with a picker beside it, like the local-session dialog, so the flow
 * can be driven by a test.
 */
export default function CloneRepoDialog({
  home,
  defaultParent,
  onClose,
  onClone
}: CloneRepoDialogProps): React.JSX.Element {
  const [source, setSource] = useState('')
  const [parent, setParent] = useState(homeRelative(defaultParent, home))
  /** Undefined until gh answers; null is gh's default account. */
  const [accounts, setAccounts] = useState<{ login: string; active: boolean }[] | null | undefined>()
  const [login, setLogin] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sourceRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    sourceRef.current?.focus()
    void window.maestro.repos.githubAccounts().then((list) => {
      setAccounts(list)
      setLogin(list?.find((a) => a.active)?.login ?? null)
    })
  }, [])

  const ready = source.trim().length > 0 && accounts !== undefined

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const err = await onClone(source.trim(), parent.trim(), login)
    setBusy(false)
    if (err) setError(err)
  }

  const browse = async (): Promise<void> => {
    const picked = await window.maestro.sessions.pickFolder()
    if (picked) setParent(homeRelative(picked, home))
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void submit()
  }

  const name = cloneName(source)
  const dest = `${parent.trim().replace(/\/+$/, '') || '~'}/${name}`

  return (
    <Modal onClose={onClose} width={480} label="Clone repo">
      <div className="modal__title">Clone repo</div>

      <div className="field">
        <label htmlFor="clone-source">Which repo?</label>
        <input
          id="clone-source"
          ref={sourceRef}
          className="input"
          placeholder="owner/name or a clone URL"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={onEnter}
        />
      </div>

      <div className="field">
        <label htmlFor="clone-parent">Into</label>
        <div className="field__row">
          <input
            id="clone-parent"
            className="input"
            placeholder="~/repos"
            spellCheck={false}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            onKeyDown={onEnter}
          />
          <button className="btn" onClick={() => void browse()}>
            <i className="ph ph-folder-open" style={{ fontSize: 15 }} />
            Choose…
          </button>
        </div>
        {name && <span className="field__hint">Clones to {dest}</span>}
      </div>

      {accounts && accounts.length > 0 && (
        <div className="field">
          <label>Clone, push and open PRs as</label>
          <div className="seg seg--lg" role="group" aria-label="GitHub account">
            {accounts.map((a) => (
              <button
                key={a.login}
                className={`seg__opt${login === a.login ? ' is-on' : ''}`}
                aria-pressed={login === a.login}
                onClick={() => setLogin(a.login)}
              >
                {a.login}
              </button>
            ))}
          </div>
          <span className="field__hint">Every session in this repo uses it</span>
        </div>
      )}

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? <span className="spinner" /> : <i className="ph ph-download-simple" style={{ fontSize: 15 }} />}
          Clone
        </button>
      </div>
    </Modal>
  )
}
