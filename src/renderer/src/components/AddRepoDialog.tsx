import { useEffect, useRef, useState } from 'react'
import { homeRelative } from '../lib/format'
import Modal from './Modal'

interface AddRepoDialogProps {
  home: string
  /** Where the clone folder field starts: beside the repos already added, where clones usually live. */
  defaultParent: string
  onClose: () => void
  onClone: (source: string, parent: string, login: string | null) => Promise<string | null>
  onAdd: (path: string) => Promise<string | null>
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
 * Adds a repo two ways: clone it as one of the person's GitHub accounts, or point at a folder
 * already on disk. A clone records the account it was cloned as; an existing folder has its account
 * worked out in main from who can push to it, and is asked about only when that is unclear.
 *
 * Paths are text fields with a picker beside them, like the local-session dialog, so both flows can
 * be driven by a test.
 */
export default function AddRepoDialog({
  home,
  defaultParent,
  onClose,
  onClone,
  onAdd
}: AddRepoDialogProps): React.JSX.Element {
  const [existing, setExisting] = useState(false)
  const [source, setSource] = useState('')
  const [parent, setParent] = useState(homeRelative(defaultParent, home))
  const [path, setPath] = useState('')
  /** Undefined until gh answers, null when gh is missing. */
  const [accounts, setAccounts] = useState<{ login: string; active: boolean }[] | null | undefined>()
  const [login, setLogin] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sourceRef = useRef<HTMLInputElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.maestro.repos.githubAccounts().then((list) => {
      setAccounts(list)
      setLogin(list?.find((a) => a.active)?.login ?? null)
    })
  }, [])

  useEffect(() => {
    if (existing) pathRef.current?.focus()
    else sourceRef.current?.focus()
    setError(null)
  }, [existing])

  const ready = existing ? path.trim().length > 0 : source.trim().length > 0 && accounts !== undefined

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const err = existing ? await onAdd(path.trim()) : await onClone(source.trim(), parent.trim(), login)
    setBusy(false)
    if (err) setError(err)
  }

  const browse = async (set: (value: string) => void): Promise<void> => {
    const picked = await window.maestro.sessions.pickFolder()
    if (picked) set(homeRelative(picked, home))
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void submit()
  }

  const name = cloneName(source)
  const dest = `${parent.trim().replace(/\/+$/, '') || '~'}/${name}`

  return (
    <Modal onClose={onClose} width={480} label="Add repo">
      <div className="modal__title">Add repo</div>

      <div className="field">
        <div className="seg seg--lg" role="group" aria-label="How to add it">
          <button
            className={`seg__opt${existing ? '' : ' is-on'}`}
            aria-pressed={!existing}
            onClick={() => setExisting(false)}
          >
            Clone
          </button>
          <button
            className={`seg__opt${existing ? ' is-on' : ''}`}
            aria-pressed={existing}
            onClick={() => setExisting(true)}
          >
            Existing folder
          </button>
        </div>
      </div>

      {existing ? (
        <div className="field">
          <label htmlFor="repo-path">Which folder?</label>
          <div className="field__row">
            <input
              id="repo-path"
              ref={pathRef}
              className="input"
              placeholder="~/repos/my-app"
              spellCheck={false}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={onEnter}
            />
            <button className="btn" onClick={() => void browse(setPath)}>
              <i className="ph ph-folder-open" style={{ fontSize: 15 }} />
              Choose…
            </button>
          </div>
          <span className="field__hint">Uses the GitHub account that can push to it, or asks</span>
        </div>
      ) : (
        <>
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
              <button className="btn" onClick={() => void browse(setParent)}>
                <i className="ph ph-folder-open" style={{ fontSize: 15 }} />
                Choose…
              </button>
            </div>
            {name && <span className="field__hint">Clones to {dest}</span>}
          </div>

          {accounts && accounts.length > 0 && (
            <div className="field">
              <label>GitHub account</label>
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
              <span className="field__hint">Clones, commits, pushes and opens PRs as this account</span>
            </div>
          )}
        </>
      )}

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? (
            <span className="spinner" />
          ) : (
            <i className={`ph ${existing ? 'ph-folder-plus' : 'ph-download-simple'}`} style={{ fontSize: 15 }} />
          )}
          {existing ? 'Add repo' : 'Clone'}
        </button>
      </div>
    </Modal>
  )
}
