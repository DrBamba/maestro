import { useEffect, useState } from 'react'
import type { AccountGuess, GithubAccounts } from '@shared/types'
import Modal from './Modal'

interface GithubAccountDialogProps {
  repoId: string
  repoName: string
  /** Set when a repo was just added and Maestro could not tell its account: only these are offered. */
  asking?: Extract<AccountGuess, { choose: string[] }>
  onClose: () => void
  onSaved: (login: string | null) => void
}

/**
 * Picks the GitHub account a repo pushes and opens PRs as. The choice lives in the repo's local git
 * config (see main/githubAccount.ts), so it is already shared by every worktree of the repo.
 *
 * "gh default" is a real choice, not an absence: it clears the setting and leaves `gh auth switch`
 * in charge, which is how the repo behaved before anything was picked.
 */
export default function GithubAccountDialog({
  repoId,
  repoName,
  asking,
  onClose,
  onSaved
}: GithubAccountDialogProps): React.JSX.Element {
  const [info, setInfo] = useState<GithubAccounts | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.maestro.repos.githubAccount(repoId).then((result) => {
      setInfo(result)
      setChoice(result?.current ?? null)
    })
  }, [repoId])

  const accounts = (info?.accounts ?? []).filter((a) => !asking || asking.choose.includes(a.login))
  const active = accounts.find((a) => a.active)?.login

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await window.maestro.repos.setGithubAccount(repoId, choice)
    onSaved(choice)
    onClose()
  }

  return (
    <Modal onClose={onClose} width={460} label="GitHub account">
      <div className="modal__title">GitHub account</div>
      <div className="modal__sub">{repoName}</div>

      {info && info.accounts === null && (
        <div className="modal__error">
          `gh` is not installed. Run `brew install gh` and `gh auth login`, then try again.
        </div>
      )}
      {info?.accounts?.length === 0 && (
        <div className="modal__error">No GitHub accounts. Run `gh auth login`, then try again.</div>
      )}

      {accounts.length > 0 && (
        <div className="field">
          <label>Commit, push and open PRs as</label>
          <div className="seg seg--lg" role="group" aria-label="GitHub account">
            <button
              className={`seg__opt${choice === null ? ' is-on' : ''}`}
              aria-pressed={choice === null}
              onClick={() => setChoice(null)}
            >
              gh default
            </button>
            {accounts.map((a) => (
              <button
                key={a.login}
                className={`seg__opt${choice === a.login ? ' is-on' : ''}`}
                aria-pressed={choice === a.login}
                onClick={() => setChoice(a.login)}
              >
                {a.login}
              </button>
            ))}
          </div>
          <div className="field__hint">
            {choice === null
              ? `Follows \`gh auth switch\`${active ? `, now ${active}` : ''}.`
              : 'Every worktree of this repo, including pushes from your own terminal.'}
          </div>
        </div>
      )}

      {asking ? (
        <div className="modal__note">
          {asking.why === 'several'
            ? 'More than one of your accounts can push here. Which should new sessions use?'
            : 'None of your accounts showed push access. Which should new sessions use?'}
        </div>
      ) : (
        /* Worth saying: agents and terminals already running keep the token they started with. */
        <div className="modal__note">Agents and terminals started from now on use it.</div>
      )}

      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void save()}
          // Asking, "gh default" is an answer worth saving, so it is never asked again.
          disabled={busy || accounts.length === 0 || (!asking && choice === (info?.current ?? null))}
        >
          <i className="ph ph-check" style={{ fontSize: 15 }} />
          Save
        </button>
      </div>
    </Modal>
  )
}
