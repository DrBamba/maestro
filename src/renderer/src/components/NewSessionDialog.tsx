import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BaseOption, LaunchSettings, Repo, StartMode } from '@shared/types'
import LaunchSettingsFields from './LaunchSettingsFields'
import Modal from './Modal'

interface NewSessionDialogProps {
  repos: Repo[]
  initialRepoId: string | null
  autoMode: boolean
  onAutoMode: (on: boolean) => void
  onClose: () => void
  onCreate: (
    repoId: string,
    name: string,
    base: string,
    mode: StartMode,
    launch: LaunchSettings
  ) => Promise<string | null>
  onImportInstead: () => void
}

/** How tall the opening-message field is allowed to grow before it starts scrolling instead. */
const PROMPT_MAX_HEIGHT = 220

export default function NewSessionDialog({
  repos,
  initialRepoId,
  autoMode,
  onAutoMode,
  onClose,
  onCreate,
  onImportInstead
}: NewSessionDialogProps): React.JSX.Element {
  const [repoId, setRepoId] = useState(initialRepoId ?? repos[0]?.id ?? '')
  const [name, setName] = useState('')
  const [launch, setLaunch] = useState<LaunchSettings>({})
  const [bases, setBases] = useState<BaseOption[]>([])
  const [base, setBase] = useState('')
  const [continueOnBase, setContinueOnBase] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /*
   * The field is as tall as what has been written into it. This text is the session's opening
   * message, not a label, so instructions worth several lines belong here — and a fixed one-line
   * box that scrolls its own beginning out of sight is what makes people write less than they mean.
   * Capped, since the dialog cannot grow past the window; only past the cap does it scroll — and
   * only then does it get a scrollbar, which is why overflow is switched rather than left on auto.
   * Left on auto, the sub-pixel by which a fitted box still overflows itself drew a thumb down the
   * side of a field with one line in it.
   */
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const wanted = el.scrollHeight
    el.style.height = `${Math.min(wanted, PROMPT_MAX_HEIGHT)}px`
    el.style.overflowY = wanted > PROMPT_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [name])

  const repo = repos.find((r) => r.id === repoId)

  /*
   * The base list twice: once from the refs already on disk, so the dialog is usable immediately,
   * and again after a fetch, so a branch a colleague pushed five minutes ago is offered too. The
   * fetch is the slow half and must not be waited on before anything can be picked.
   *
   * The second load keeps the choice already made rather than resetting to the default branch —
   * the list growing underneath must not move the selection out from under the user. Changing repo
   * does reset it, because the old choice is not in the new repo's list.
   */
  useEffect(() => {
    if (!repoId) return
    let stale = false

    const load = async (): Promise<void> => {
      const options = await window.maestro.sessions.baseOptions(repoId)
      if (stale) return
      setBases(options)
      setBase((current) =>
        options.some((o) => o.ref === current) ? current : (options[0]?.ref ?? '')
      )
    }

    setFetching(true)
    void load()
    void window.maestro.repos
      .fetch(repoId)
      .then(load)
      .finally(() => {
        if (!stale) setFetching(false)
      })

    return () => {
      stale = true
    }
  }, [repoId])

  /*
   * Whether the worktree this would cut comes with a setup script — asked of the base ref, not of
   * the repo, because that is what decides it: the script is a file in the tree being checked out.
   * The note below promises a new worktree runs one, and it must not promise that of a base whose
   * tree has none.
   */
  const [hasSetup, setHasSetup] = useState(false)
  useEffect(() => {
    if (!repoId) {
      setHasSetup(false)
      return
    }
    let stale = false
    void window.maestro.repos.setupScriptAt(repoId, base).then((found) => {
      if (!stale) setHasSetup(found)
    })
    return () => {
      stale = true
    }
  }, [repoId, base])

  const sessionBases = useMemo(() => bases.filter((b) => b.kind === 'session'), [bases])
  const branchBases = useMemo(() => bases.filter((b) => b.kind === 'branch'), [bases])
  const remoteBases = useMemo(() => bases.filter((b) => b.kind === 'remote'), [bases])
  const selected = bases.find((b) => b.ref === base)

  /*
   * git allows one checkout per ref, so continuing is only on offer while nothing holds the branch.
   * The tick is dropped rather than remembered when the choice moves to a branch that is taken —
   * otherwise it would sit there checked, describing something the session cannot do.
   */
  const occupiedBy = selected?.checkedOutAt ?? null
  const canContinue = Boolean(selected) && occupiedBy === null

  /*
   * Who holds it, said in the shortest form that identifies it: an in-flight session by name, and
   * anything else — the primary clone, a worktree Maestro does not know — by directory. The full
   * path is worth nothing here and long enough to push the dialog around.
   */
  const heldBy =
    selected?.kind === 'session' ? `“${selected.label}”` : (occupiedBy?.split('/').pop() ?? '')

  /*
   * What continuing on a remote branch actually produces: `origin/fix-login` is not a branch this
   * clone can check out, so the session gets a local `fix-login` tracking it — which is what makes
   * a later push land on that same remote branch instead of a fork of it.
   */
  const localName =
    selected?.kind === 'remote' ? selected.ref.split('/').slice(1).join('/') : (selected?.ref ?? '')
  const mode: StartMode = canContinue && continueOnBase ? 'continue' : 'branch'
  useEffect(() => {
    if (!canContinue) setContinueOnBase(false)
  }, [canContinue])

  /*
   * The button and the Enter key must agree on this. They did not: the button also required a
   * loaded `base`, so while the option list was still empty — or if it failed to load at all —
   * Enter created the session and clicking "Create session" did nothing. An empty base is not
   * an error condition anyway: createSession reads it as the repo's default branch.
   *
   * Saying what you are building is optional in both modes. The worktree and the branch are named
   * from a random handle, never from this text, so nothing here has to be known before the session
   * can be cut — and leaving it empty is a choice rather than an omission: the session opens on
   * Claude's own prompt, where skills, file completions and everything else it offers are native.
   */
  const canSubmit = Boolean(repoId) && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const err = await onCreate(repoId, name.trim(), base, mode, launch)
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <Modal onClose={onClose} width={480} label="New session">
      <div className="modal__title">New session</div>

      <div className="field">
        <label>Repo</label>
        <div className="seg seg--lg" role="group" aria-label="Repo">
          {repos.map((r) => (
            <button
              key={r.id}
              className={`seg__opt${r.id === repoId ? ' is-on' : ''}`}
              onClick={() => setRepoId(r.id)}
            >
              {r.name}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="session-name">What are you building?</label>
        <textarea
          id="session-name"
          ref={inputRef}
          className="input textarea textarea--grow"
          rows={1}
          placeholder="e.g. fix the double page on the verdict list"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            /*
             * Enter still creates the session — it is the one action this dialog is for, and the
             * button repeats it. Shift+Enter takes the newline instead, which is the only way to
             * write more than a sentence in a field whose default key submits.
             */
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {/* The hint describes the door you are standing at: the shortcut once there is text to
            write, and otherwise what pressing Create with none of it does. */}
        <span className="field__hint">
          {name.trim() ? 'Shift+Enter for a new line' : 'Empty opens Claude waiting for your first message'}
        </span>
      </div>

      <div className="field">
        <label htmlFor="session-base">Start from</label>
        <select
          id="session-base"
          className="input"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        >
          {bases
            .filter((b) => b.kind === 'default')
            .map((b) => (
              <option key={b.ref} value={b.ref}>
                {b.label} (default branch)
              </option>
            ))}
          {sessionBases.length > 0 && (
            <optgroup label="Sessions">
              {sessionBases.map((b) => (
                <option key={b.ref} value={b.ref}>
                  {b.label}
                </option>
              ))}
            </optgroup>
          )}
          {branchBases.length > 0 && (
            <optgroup label="Branches">
              {branchBases.map((b) => (
                <option key={b.ref} value={b.ref}>
                  {b.label}
                </option>
              ))}
            </optgroup>
          )}
          {remoteBases.length > 0 && (
            <optgroup label="Remote branches">
              {remoteBases.map((b) => (
                <option key={b.ref} value={b.ref}>
                  {b.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {fetching && <span className="field__hint">Fetching remote branches…</span>}
      </div>

      {selected && (
        <button
          className="checkbox"
          aria-label="Continue on this branch"
          disabled={!canContinue}
          onClick={() => setContinueOnBase((v) => !v)}
        >
          <span className={`checkbox__box${mode === 'continue' ? ' is-on' : ''}`}>
            {mode === 'continue' && <i className="ph ph-check" />}
          </span>
          <span className="checkbox__label">
            Work on <span style={{ fontFamily: 'var(--font-mono)' }}>{selected.ref}</span> directly,
            without a new branch
            {selected.kind === 'remote' && ' (through a local branch tracking it)'}
            {occupiedBy && <>. Unavailable — {heldBy} has it checked out.</>}
          </span>
        </button>
      )}

      <LaunchSettingsFields
        value={launch}
        onChange={setLaunch}
        autoMode={autoMode}
        onAutoMode={onAutoMode}
      />

      <div className="modal__note">
        {mode === 'continue' ? (
          <>
            {selected?.kind === 'remote' ? (
              <>
                Checks out a local{' '}
                <span style={{ color: 'var(--color-neutral-400)' }}>{localName}</span> tracking{' '}
                <span style={{ color: 'var(--color-neutral-400)' }}>{selected.ref}</span> in a new
                worktree
                {hasSetup ? ', runs the setup script,' : ''} and starts Claude Code.
                Commits push back to that remote branch — nothing to merge.
              </>
            ) : (
              <>
                Checks out <span style={{ color: 'var(--color-neutral-400)' }}>{localName || base}</span>{' '}
                in a new worktree
                {hasSetup ? ', runs the setup script,' : ''} and starts Claude Code.
                Commits land on that branch — nothing to merge.
              </>
            )}
            {name.trim() ? '' : ' Named after the branch.'}
          </>
        ) : (
          <>
            Cuts a worktree on its own branch from{' '}
            <span style={{ color: 'var(--color-neutral-400)' }}>{base || repo?.defaultBranch}</span>
            {hasSetup ? ', runs the setup script,' : ''} and{' '}
            {name.trim()
              ? 'starts Claude Code with what you typed as its first message'
              : 'opens Claude Code there, waiting for your first message'}
            . Named from Claude’s summary of it.
            {selected?.kind === 'session' && (
              <>
                {' '}
                Only work <span style={{ color: 'var(--color-neutral-400)' }}>committed</span> in “
                {selected.label}” carries over.
              </>
            )}
          </>
        )}
      </div>

      {error && <div className="modal__error">{error}</div>}

      <button className="modal__link" onClick={onImportInstead}>
        or import a worktree that already exists
      </button>

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {busy ? <span className="spinner" /> : <i className="ph ph-plus" style={{ fontSize: 15 }} />}
          Create session
        </button>
      </div>
    </Modal>
  )
}
