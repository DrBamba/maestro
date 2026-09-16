import { useEffect, useState } from 'react'
import type { ImportableWorktree, RelocatePlan } from '@shared/types'
import Modal from './Modal'

interface ImportSessionDialogProps {
  home: string
  onClose: () => void
  onImport: (path: string) => Promise<string | null>
  onRelocate: (path: string) => Promise<string | null>
  onPick: () => Promise<string | null>
}

/**
 * Adopts a worktree that already exists — typically one where a Claude session was started
 * outside Maestro. The worktree is not moved: Claude Code keys its conversation history by
 * absolute path, so relocating it would orphan the very session the user wants back.
 */
export default function ImportSessionDialog({
  home,
  onClose,
  onImport,
  onRelocate,
  onPick
}: ImportSessionDialogProps): React.JSX.Element {
  const [items, setItems] = useState<ImportableWorktree[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The primary clone the user picked, held while they choose move-or-adopt. */
  const [confirming, setConfirming] = useState<ImportableWorktree | null>(null)
  const [plan, setPlan] = useState<RelocatePlan | null>(null)
  /** Gates the move when Maestro is running out of the directory being moved. */
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    void window.maestro.sessions.importable().then(setItems)
  }, [])

  // The plan comes from main, so the paths and commands shown are the ones that will run.
  useEffect(() => {
    if (!confirming) return
    setPlan(null)
    void window.maestro.sessions.relocatePlan(confirming.path).then(setPlan)
  }, [confirming])

  const run = async (path: string, action: () => Promise<string | null>): Promise<void> => {
    setBusy(path)
    setError(null)
    const err = await action()
    setBusy(null)
    if (err) setError(err)
  }

  if (confirming) {
    const item = confirming
    const short = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p)

    return (
      <Modal onClose={onClose} width={560} label="Primary clone">
        <div className="modal__title">That’s the primary clone</div>
        <div className="modal__sub">
          {item.branch} · {short(item.path)}
        </div>
        <div className="modal__note">
          Working here ties up the one clone every other session shares.
        </div>

        {plan === null ? (
          <div className="launcher__empty">Checking what this would do…</div>
        ) : plan.blocked ? (
          <div className="modal__note">{plan.blocked}</div>
        ) : (
          <>
            {plan.selfHosted && (
              <>
                <div className="modal__error">
                  Maestro is running from this directory. The move returns the clone to{' '}
                  {plan.defaultBranch}, so this instance loses its source and stops. Relaunch from
                  the new worktree:
                </div>
                <pre className="cmd-block">
                  {`cd ${plan.worktreePath}\nnpm install\nnpm run dev`}
                </pre>
                <button className="checkbox" onClick={() => setAcknowledged((v) => !v)}>
                  <span className={`checkbox__box${acknowledged ? ' is-on' : ''}`}>
                    {acknowledged && <i className="ph ph-check" />}
                  </span>
                  <span className="checkbox__label">
                    I understand this instance will stop and I will relaunch it
                  </span>
                </button>
              </>
            )}

            <div className="field">
              <label>Afterwards</label>
              <div className="outcome">
                <div className="outcome__row">
                  <span className="outcome__where">{short(plan.primaryPath)}</span>
                  <span className="outcome__what">
                    on <b>{plan.defaultBranch}</b>, clean
                  </span>
                </div>
                <div className="outcome__row">
                  <span className="outcome__where">{short(plan.worktreePath)}</span>
                  <span className="outcome__what">
                    <b>{plan.branch}</b>
                    {plan.dirtyCount > 0 && ` + your ${plan.dirtyCount} uncommitted file${plan.dirtyCount === 1 ? '' : 's'}`}
                    {plan.hasHistory && ' + the Claude conversation'}
                  </span>
                </div>
              </div>
            </div>

            <div className="field">
              <label>Commands</label>
              <pre className="cmd-block">
                {plan.steps
                  .map((step) => [`cd ${step.cwd}`, ...step.commands].join('\n'))
                  .join('\n\n')}
              </pre>
            </div>
          </>
        )}

        {error && <div className="modal__error">{error}</div>}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={() => setConfirming(null)}>
            Back
          </button>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => void run(item.path, () => onImport(item.path))}
          >
            Leave it where it is
          </button>
          {plan && !plan.blocked && (
            <button
              className="btn btn--primary"
              disabled={busy !== null || (plan.selfHosted && !acknowledged)}
              onClick={() => void run(item.path, () => onRelocate(item.path))}
            >
              {busy === item.path ? (
                <span className="spinner" />
              ) : (
                <i className="ph ph-check" style={{ fontSize: 15 }} />
              )}
              Move it — recommended
            </button>
          )}
        </div>
      </Modal>
    )
  }

  return (
    <Modal onClose={onClose} width={560} label="Import existing worktree">
      <div className="modal__title">Import existing worktree</div>
      <div className="modal__sub">Adopts a worktree in place. Nothing moves or is copied.</div>

      <div className="import-list">
        {items === null && <div className="sidebar__empty">Looking for worktrees…</div>}

        {items?.length === 0 && (
          <div className="sidebar__empty">
            Nothing left to adopt in your repos. Use “Choose folder” for a repo Maestro does not
            know yet.
          </div>
        )}

        {items?.map((item) => (
          <button
            key={item.path}
            className="import-row"
            disabled={busy !== null}
            onClick={() =>
              // Choosing the primary clone offers the fix instead of quietly adopting it.
              item.isPrimaryClone
                ? setConfirming(item)
                : void run(item.path, () => onImport(item.path))
            }
          >
            <div className="import-row__main">
              <span className="import-row__branch">
                <i className="ph ph-git-branch" />
                {item.branch}
              </span>
              <span className="import-row__path">{item.path}</span>
            </div>
            <div className="import-row__tags">
              <span className="import-row__repo">{item.repoName}</span>
              {item.isPrimaryClone && <span className="import-row__primary">primary clone</span>}
              {item.dirtyCount > 0 && (
                <span className="import-row__wip">
                  {item.dirtyCount} uncommitted
                </span>
              )}
              {item.hasHistory ? (
                <span className="import-row__history">
                  <i className="ph ph-arrow-counter-clockwise" />
                  resumable
                </span>
              ) : (
                <span className="import-row__nohistory">no history</span>
              )}
            </div>
            {busy === item.path && <span className="spinner" />}
          </button>
        ))}
      </div>

      <div className="modal__note">
        <span style={{ color: 'var(--color-neutral-400)' }}>resumable</span> means Claude Code has
        history for that directory, so Maestro launches it with{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>--continue</span>. Quit any Claude already
        running there first.
      </div>

      {error && <div className="modal__error">{error}</div>}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() => void run('__pick__', onPick)}
        >
          <i className="ph ph-folder-open" style={{ fontSize: 15 }} />
          Choose folder…
        </button>
      </div>
    </Modal>
  )
}
