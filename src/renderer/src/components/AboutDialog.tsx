import Modal from './Modal'
import { homeRelative } from '../lib/format'

interface AboutDialogProps {
  /** Which data directory this instance uses — `dev` and `custom` keep their own. */
  profile: 'stable' | 'dev' | 'custom'
  /** The checkout an unpackaged run came out of, empty for the installed app. */
  sourceLabel: string
  worktreeRoot: string
  localRoot: string
  home: string
  onClose: () => void
}

const PROFILE_WORD: Record<'stable' | 'dev' | 'custom', string> = {
  stable: 'Installed',
  dev: 'Dev',
  custom: 'Custom profile'
}

/** What this Maestro is and where it keeps things — the answers worth having in front of you. */
export default function AboutDialog({
  profile,
  sourceLabel,
  worktreeRoot,
  localRoot,
  home,
  onClose
}: AboutDialogProps): React.JSX.Element {
  const rows = [
    ['Running', sourceLabel ? `${PROFILE_WORD[profile]} · ${sourceLabel}` : PROFILE_WORD[profile]],
    ['Worktrees', homeRelative(worktreeRoot, home)],
    ['Local folders', homeRelative(localRoot, home)]
  ]

  return (
    <Modal onClose={onClose} width={420} label="About Maestro">
      <div className="modal__title">About Maestro</div>

      <div className="about">
        {rows.map(([label, value]) => (
          <div className="about__row" key={label}>
            <span className="about__label">{label}</span>
            <span className="about__value" data-tip={value}>
              {value}
            </span>
          </div>
        ))}
      </div>

      <div className="modal__actions">
        <button className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
