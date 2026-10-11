import type { Preferences, ThemePreference } from '@shared/types'
import Modal from './Modal'
import { playChime } from '../lib/chime'

interface SettingsDialogProps {
  preferences: Preferences
  onChange: (patch: Partial<Preferences>) => void
  onClose: () => void
}

/** Dark first: it is the theme this was designed on and the one an unset preference means. */
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' }
]

/**
 * App-wide settings — appearance, how Claude starts, and whether finishing makes a sound. Per-repo
 * setup and run scripts are still edited nowhere, and belong to a repo rather than here when they
 * arrive.
 */
export default function SettingsDialog({
  preferences,
  onChange,
  onClose
}: SettingsDialogProps): React.JSX.Element {
  const auto = preferences.permissionMode === 'auto'
  const theme = preferences.theme ?? 'dark'
  const chime = preferences.chime === true
  const remote = preferences.remoteUpdates === true
  const skipTests = preferences.skipUpdateTests === true

  return (
    <Modal onClose={onClose} width={460} label="Settings">
      <div className="modal__title">Settings</div>

      <div className="field">
        <label>Appearance</label>
        <div className="seg seg--lg" role="group" aria-label="Appearance">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={`seg__opt${theme === option.value ? ' is-on' : ''}`}
              aria-pressed={theme === option.value}
              onClick={() => onChange({ theme: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
        {/* The reason this is worth saying: the two embeds are separate programs with themes of
            their own, and a setting that only repainted the shell around them would be worse than
            no setting at all. */}
        <div className="field__hint">
          {theme === 'system'
            ? 'Follows macOS, and changes with it. The terminal and the embedded editor follow too.'
            : 'The terminal and the embedded editor change with the shell.'}
        </div>
      </div>

      <div className="field">
        <label>How Claude starts</label>
        <button
          className="checkbox"
          aria-label="Start Claude in auto mode"
          onClick={() => onChange({ permissionMode: auto ? undefined : 'auto' })}
        >
          <span className={`checkbox__box${auto ? ' is-on' : ''}`}>
            {auto && <i className="ph ph-check" />}
          </span>
          <span className="checkbox__label">
            Start every session in auto mode — Claude approves its own tool use
          </span>
        </button>
      </div>

      {/*
       * Two things worth saying outright: the mode is fixed when the process starts, so this is not
       * a switch for a session already running; and off means Maestro passes no mode at all, which
       * leaves whatever the user configured for Claude Code itself in charge rather than overriding
       * it with a Maestro opinion.
       */}
      <div className="modal__note">
        {auto
          ? 'Applies to sessions started from now on. Inside a running session, shift+tab switches mode.'
          : 'Off: Claude Code’s own settings decide. Inside a running session, shift+tab switches mode.'}
      </div>

      <div className="field">
        <label>When a session wants you</label>
        <button
          className="checkbox"
          aria-label="Play a sound when a session finishes"
          onClick={() => {
            // Played on the way on, not off: the one question a sound toggle raises is what the
            // sound is, and answering it here beats waiting for a session to finish to find out.
            if (!chime) playChime()
            onChange({ chime: chime ? undefined : true })
          }}
        >
          <span className={`checkbox__box${chime ? ' is-on' : ''}`}>
            {chime && <i className="ph ph-check" />}
          </span>
          <span className="checkbox__label">
            Play a sound when a session finishes, needs an answer, or is interrupted
          </span>
        </button>
      </div>

      <div className="modal__note">
        {chime
          ? 'Only the states that want you — a session getting on with its work stays quiet.'
          : 'Off. Sessions still change colour in the sidebar; they just do it silently.'}
      </div>

      <div className="field">
        <label>Updates</label>
        <button
          className="checkbox"
          aria-label="Fetch updates from the remote"
          onClick={() => onChange({ remoteUpdates: remote ? undefined : true })}
        >
          <span className={`checkbox__box${remote ? ' is-on' : ''}`}>
            {remote && <i className="ph ph-check" />}
          </span>
          <span className="checkbox__label">
            Fetch Maestro’s own repository every five minutes
          </span>
        </button>
      </div>

      {/*
       * Worth saying because it moves a branch in a repository the user owns — a fast-forward, the
       * same one `git pull` would do, and only from a clean `main`.
       */}
      <div className="modal__note">
        {remote
          ? 'Fast-forwards main when the remote is ahead, so updates there are offered here.'
          : 'Off: updates are offered when main moves on this machine.'}
      </div>

      <div className="field">
        <button
          className="checkbox"
          aria-label="Skip tests when updating"
          onClick={() => onChange({ skipUpdateTests: skipTests ? undefined : true })}
        >
          <span className={`checkbox__box${skipTests ? ' is-on' : ''}`}>
            {skipTests && <i className="ph ph-check" />}
          </span>
          <span className="checkbox__label">Skip tests when updating Maestro</span>
        </button>
      </div>

      {/* Worth saying because the tests are what keep a broken main from replacing a working app. */}
      {skipTests && (
        <div className="modal__note">
          Updates only build main. A build whose window never comes up is still backed out.
        </div>
      )}

      <div className="modal__actions">
        <button className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
