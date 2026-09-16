import { useEffect, useRef, useState } from 'react'
import type { LaunchSettings } from '@shared/types'
import { homeRelative } from '../lib/format'
import LaunchSettingsFields from './LaunchSettingsFields'
import Modal from './Modal'

interface LocalSessionDialogProps {
  home: string
  /** Where Maestro makes a local session's folder — main decides the convention, not this dialog. */
  localRoot: string
  autoMode: boolean
  onAutoMode: (on: boolean) => void
  onClose: () => void
  onCreate: (name: string, path: string, launch: LaunchSettings) => Promise<string | null>
}

/** Last path segment, for defaulting the name — the folder is usually what you would call it. */
function lastSegment(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

/**
 * Opens a folder as a session, the same two ways a repo session opens: Maestro makes the directory,
 * or it works in one that already exists.
 *
 * The two modes ask for different things, because they are answering different questions. A folder
 * Maestro makes is empty, so the only thing worth saying is what the work is — that becomes Claude's
 * opening message and, through Claude's summary of it, the session's name. A folder that already
 * exists has its own contents and its own name; there is nothing to brief anyone on, so it asks for
 * a label and nothing else.
 *
 * The path is a text field with a picker beside it rather than the picker alone — typing `~/notes`
 * beats clicking through four levels of Finder, and a native picker is a modal the app cannot see
 * into, so a folder chosen that way could never be tested.
 */
export default function LocalSessionDialog({
  home,
  localRoot,
  autoMode,
  onAutoMode,
  onClose,
  onCreate
}: LocalSessionDialogProps): React.JSX.Element {
  const [existing, setExisting] = useState(false)
  const [path, setPath] = useState('')
  /** The prompt when Maestro makes the folder, the label when it does not. */
  const [text, setText] = useState('')
  const [launch, setLaunch] = useState<LaunchSettings>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const promptRef = useRef<HTMLInputElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)

  // Focus follows the mode: the prompt is the only thing a new folder needs, the path is the only
  // thing an existing one does.
  useEffect(() => {
    if (existing) pathRef.current?.focus()
    else promptRef.current?.focus()
  }, [existing])

  /*
   * An existing folder still needs to be pointed at. A folder Maestro makes needs nothing: it takes
   * a random handle either way, so saying what the work is only decides whether Claude opens on that
   * message or on its own empty prompt.
   */
  const ready = existing ? path.trim().length > 0 : true

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    const err = await onCreate(text.trim(), existing ? path.trim() : '', launch)
    setBusy(false)
    if (err) setError(err)
  }

  const browse = async (): Promise<void> => {
    const picked = await window.maestro.sessions.pickFolder()
    if (picked) {
      setPath(homeRelative(picked, home))
      setError(null)
    }
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void submit()
  }

  /**
   * Where the folder goes, not what it will be called: the directory takes a random handle chosen
   * at creation, so naming it here would be a guess. Empty until the snapshot lands, for the same
   * reason — a guess about where files are going is worse than saying nothing.
   */
  const destination = localRoot ? homeRelative(localRoot, home) : ''

  return (
    <Modal onClose={onClose} width={480} label="New local session">
      <div className="modal__title">Local session</div>
      <div className="modal__sub">A folder to work in, with no repo behind it.</div>

      <div className="field">
        <label>Folder</label>
        <div className="seg seg--lg" role="group" aria-label="Folder">
          <button className={`seg__opt${existing ? '' : ' is-on'}`} onClick={() => setExisting(false)}>
            Maestro makes one
          </button>
          <button className={`seg__opt${existing ? ' is-on' : ''}`} onClick={() => setExisting(true)}>
            One I already have
          </button>
        </div>
      </div>

      {existing ? (
        <>
          <div className="field">
            <label htmlFor="local-path">Which folder</label>
            <div className="field__row">
              <input
                id="local-path"
                ref={pathRef}
                className="input"
                placeholder="~/notes"
                spellCheck={false}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={onEnter}
              />
              <button className="btn" onClick={() => void browse()}>
                <i className="ph ph-folder-open" style={{ fontSize: 15 }} />
                Choose…
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="local-name">Name</label>
            <input
              id="local-name"
              className="input"
              placeholder={lastSegment(path) || 'the folder’s name'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onEnter}
            />
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="local-prompt">What are you working on?</label>
          <input
            id="local-prompt"
            ref={promptRef}
            className="input"
            placeholder="e.g. draft the release notes for 2.4"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onEnter}
          />
          {!text.trim() && (
            <span className="field__hint">Empty opens Claude waiting for your first message</span>
          )}
        </div>
      )}

      <LaunchSettingsFields
        value={launch}
        onChange={setLaunch}
        autoMode={autoMode}
        onAutoMode={onAutoMode}
      />

      {/*
       * The settings file is only worth a sentence for a folder the user already owns, where a new
       * file appearing is a surprise. In a folder Maestro just made it is Maestro's own business.
       */}
      <div className="modal__note">
        {existing ? (
          <>
            Runs Claude Code and the editor in that folder, in place. Adds{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>.claude/settings.local.json</span> to
            track the agent’s state.
          </>
        ) : (
          <>
            Makes a folder under{' '}
            {destination ? (
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-neutral-400)' }}>
                {destination}
              </span>
            ) : (
              'the Maestro root'
            )}{' '}
            and{' '}
            {text.trim()
              ? 'starts Claude Code with what you typed as its first message'
              : 'opens Claude Code there, waiting for your first message'}
            . Named from Claude’s summary of it.
          </>
        )}
      </div>

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? <span className="spinner" /> : <i className="ph ph-plus" style={{ fontSize: 15 }} />}
          {existing ? 'Open folder' : 'Create folder'}
        </button>
      </div>
    </Modal>
  )
}
