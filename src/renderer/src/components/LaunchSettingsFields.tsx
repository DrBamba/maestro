import { useState } from 'react'
import type { ClaudeModel, EffortLevel, LaunchSettings } from '@shared/types'

interface LaunchSettingsFieldsProps {
  value: LaunchSettings
  onChange: (value: LaunchSettings) => void
  /**
   * Auto mode is app-wide rather than per session, and is offered here anyway because this is
   * where the decision is actually being made — the same act as ticking it in Settings.
   */
  autoMode: boolean
  onAutoMode: (on: boolean) => void
}

/*
 * Aliases, in the order someone picks between them: the biggest model first, the cheapest last.
 * '' is the empty selection — no flag, so whatever `claude` is configured to do stays in charge.
 */
const MODELS: { value: ClaudeModel | ''; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'opus[1m]', label: 'Opus, 1M context' },
  { value: 'opusplan', label: 'Opus while planning, Sonnet after' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'sonnet[1m]', label: 'Sonnet, 1M context' },
  { value: 'haiku', label: 'Haiku' }
]

const EFFORTS: { value: EffortLevel | ''; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

/**
 * How Claude starts, folded away until asked for.
 *
 * Collapsed by default because the answer is usually "however it started last time", and a new
 * session should be one sentence and a button. What has been chosen is on the row itself, so the
 * settings never hide behind a caret once they differ from the default.
 */
export default function LaunchSettingsFields({
  value,
  onChange,
  autoMode,
  onAutoMode
}: LaunchSettingsFieldsProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const chosen = [
    MODELS.find((m) => m.value === value.model && m.value)?.label,
    value.effort ? `${EFFORTS.find((e) => e.value === value.effort)?.label.toLowerCase()} effort` : null,
    autoMode ? 'auto mode' : null
  ].filter(Boolean)

  return (
    <div className="launch-settings">
      <button
        className="disclosure"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <i className={`ph ph-caret-${open ? 'down' : 'right'}`} />
        How Claude starts
        {!open && chosen.length > 0 && (
          <span className="disclosure__summary">{chosen.join(' · ')}</span>
        )}
      </button>

      {open && (
        <div className="disclosure__body">
          <div className="field">
            <label htmlFor="launch-model">Model</label>
            <select
              id="launch-model"
              className="input"
              value={value.model ?? ''}
              onChange={(e) =>
                onChange({ ...value, model: (e.target.value || undefined) as ClaudeModel | undefined })
              }
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="launch-effort">Effort</label>
            <select
              id="launch-effort"
              className="input"
              value={value.effort ?? ''}
              onChange={(e) =>
                onChange({ ...value, effort: (e.target.value || undefined) as EffortLevel | undefined })
              }
            >
              {EFFORTS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
            {/* Two things the selects cannot say: how long the choice lasts, and the way out of it. */}
            <span className="field__hint">
              Kept for this session. <span style={{ fontFamily: 'var(--font-mono)' }}>/model</span>{' '}
              and <span style={{ fontFamily: 'var(--font-mono)' }}>/effort</span> change it while it
              runs.
            </span>
          </div>

          <button
            className="checkbox"
            aria-label="Start Claude in auto mode"
            onClick={() => onAutoMode(!autoMode)}
          >
            <span className={`checkbox__box${autoMode ? ' is-on' : ''}`}>
              {autoMode && <i className="ph ph-check" />}
            </span>
            <span className="checkbox__label">
              Auto mode — Claude approves its own tool use. Applies to every session until you turn
              it off.
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
