import { useCallback, useEffect, useRef, useState } from 'react'
import { GITIGNORE_TEMPLATES, type GitignoreTemplate, type NewRepoOptions } from '@shared/types'
import { homeRelative } from '../lib/format'
import GithubAccountField from './GithubAccountField'
import Modal from './Modal'

type Mode = 'clone' | 'new' | 'existing'

interface AddRepoDialogProps {
  home: string
  /** Where the clone and new folder fields start: beside the repos already added. */
  defaultParent: string
  onClose: () => void
  onClone: (source: string, parent: string, login: string | null) => Promise<string | null>
  onCreate: (opts: NewRepoOptions) => Promise<string | null>
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

function Checkbox({
  on,
  onToggle,
  label,
  disabled
}: {
  on: boolean
  onToggle: () => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button className="checkbox" role="checkbox" aria-checked={on} onClick={onToggle} disabled={disabled}>
      <span className={`checkbox__box${on ? ' is-on' : ''}`}>{on && <i className="ph ph-check" />}</span>
      <span className="checkbox__label">{label}</span>
    </button>
  )
}

/**
 * Adds a repo three ways: clone it as one of the person's GitHub accounts, start a new one, or
 * point at a folder already on disk. A clone or a new repo records the account it was made as; an
 * existing folder has its account worked out in main from who can push to it, and is asked about
 * only when that is unclear.
 *
 * Paths are text fields with a picker beside them, like the local-session dialog, so every flow can
 * be driven by a test.
 */
export default function AddRepoDialog({
  home,
  defaultParent,
  onClose,
  onClone,
  onCreate,
  onAdd
}: AddRepoDialogProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('clone')
  const [source, setSource] = useState('')
  const [parent, setParent] = useState(homeRelative(defaultParent, home))
  const [path, setPath] = useState('')
  const [newPath, setNewPath] = useState(`${homeRelative(defaultParent, home).replace(/\/+$/, '') || '~'}/`)
  const [readme, setReadme] = useState(true)
  const [gitignore, setGitignore] = useState<GitignoreTemplate>('none')
  const [license, setLicense] = useState(false)
  const [branch, setBranch] = useState('main')
  const [commit, setCommit] = useState(true)
  const [publish, setPublish] = useState<NewRepoOptions['publish']>('off')
  /** Undefined until gh answers, null when gh is missing. */
  const [accounts, setAccounts] = useState<{ login: string; active: boolean }[] | null | undefined>()
  const [login, setLogin] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sourceRef = useRef<HTMLInputElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)
  const newPathRef = useRef<HTMLInputElement>(null)

  const loadAccounts = useCallback(() => {
    void window.maestro.repos.githubAccounts().then((list) => {
      setAccounts(list)
      setLogin(list?.find((a) => a.active)?.login ?? list?.[0]?.login ?? null)
    })
  }, [])

  useEffect(loadAccounts, [loadAccounts])

  useEffect(() => {
    if (mode === 'existing') pathRef.current?.focus()
    else if (mode === 'new') newPathRef.current?.focus()
    else sourceRef.current?.focus()
    setError(null)
  }, [mode])

  const newName = newPath.trim().replace(/\/+$/, '').split('/').pop() ?? ''

  const ready =
    mode === 'existing'
      ? path.trim().length > 0
      : mode === 'new'
        ? newName.length > 0 && newName !== '~' && accounts !== undefined
        : source.trim().length > 0 && accounts !== undefined

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const err =
      mode === 'existing'
        ? await onAdd(path.trim())
        : mode === 'new'
          ? await onCreate({
              path: newPath.trim(),
              login,
              branch: branch.trim(),
              readme,
              gitignore,
              license,
              commit,
              publish: login ? publish : 'off'
            })
          : await onClone(source.trim(), parent.trim(), login)
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

  const tab = (value: Mode, label: string): React.JSX.Element => (
    <button
      className={`seg__opt${mode === value ? ' is-on' : ''}`}
      aria-pressed={mode === value}
      onClick={() => setMode(value)}
    >
      {label}
    </button>
  )

  const action =
    mode === 'existing'
      ? { icon: 'ph-folder-plus', label: 'Add repo' }
      : mode === 'new'
        ? { icon: 'ph-plus', label: 'Create' }
        : { icon: 'ph-download-simple', label: 'Clone' }

  return (
    <Modal onClose={onClose} width={500} label="Add repo">
      <div className="modal__title">Add repo</div>

      <div className="field">
        <div className="seg seg--lg" role="group" aria-label="How to add it">
          {tab('clone', 'Clone')}
          {tab('new', 'New')}
          {tab('existing', 'Existing folder')}
        </div>
      </div>

      {mode === 'existing' && (
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
      )}

      {mode === 'clone' && (
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

          <GithubAccountField
            accounts={accounts}
            login={login}
            onPick={setLogin}
            onConnected={loadAccounts}
            hint="Clones, commits, pushes and opens PRs as this account"
          />
        </>
      )}

      {mode === 'new' && (
        <>
          <div className="field">
            <label htmlFor="new-path">Where?</label>
            <div className="field__row">
              <input
                id="new-path"
                ref={newPathRef}
                className="input"
                placeholder="~/repos/my-app"
                spellCheck={false}
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={onEnter}
              />
              <button className="btn" onClick={() => void browse(setNewPath)}>
                <i className="ph ph-folder-open" style={{ fontSize: 15 }} />
                Choose…
              </button>
            </div>
            <span className="field__hint">A new or existing folder that isn't a repo yet</span>
          </div>

          <GithubAccountField
            accounts={accounts}
            login={login}
            onPick={setLogin}
            onConnected={loadAccounts}
            hint="Commits, pushes and opens PRs as this account"
          />

          <div className="field">
            <label>Start with</label>
            <div className="field__row field__row--wrap">
              <Checkbox on={readme} onToggle={() => setReadme((v) => !v)} label="README" />
              <Checkbox on={license} onToggle={() => setLicense((v) => !v)} label="MIT license" />
              <select
                id="new-gitignore"
                className="input input--compact"
                aria-label=".gitignore"
                value={gitignore}
                onChange={(e) => setGitignore(e.target.value as GitignoreTemplate)}
              >
                {GITIGNORE_TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t === 'none' ? 'No .gitignore' : `${t} .gitignore`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="new-branch">Branch</label>
            <div className="field__row">
              <input
                id="new-branch"
                className="input input--compact"
                spellCheck={false}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                onKeyDown={onEnter}
              />
              <Checkbox on={commit} onToggle={() => setCommit((v) => !v)} label="First commit" />
            </div>
            {!commit && <span className="field__hint">New sessions need a first commit to branch from</span>}
          </div>

          <div className="field">
            <label>On GitHub</label>
            <div className="seg seg--lg" role="group" aria-label="On GitHub">
              {(['off', 'private', 'public'] as const).map((p) => (
                <button
                  key={p}
                  className={`seg__opt${publish === p ? ' is-on' : ''}`}
                  aria-pressed={publish === p}
                  disabled={!login && p !== 'off'}
                  onClick={() => setPublish(p)}
                >
                  {p === 'off' ? 'Local only' : p === 'private' ? 'Private' : 'Public'}
                </button>
              ))}
            </div>
            {login && publish !== 'off' && newName && (
              <span className="field__hint">
                Creates {login}/{newName}
                {commit ? ' and pushes' : ''}
              </span>
            )}
            {!login && <span className="field__hint">Connect an account to publish</span>}
          </div>
        </>
      )}

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? <span className="spinner" /> : <i className={`ph ${action.icon}`} style={{ fontSize: 15 }} />}
          {action.label}
        </button>
      </div>
    </Modal>
  )
}
