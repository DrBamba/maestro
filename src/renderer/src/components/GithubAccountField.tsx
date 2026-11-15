import { useEffect, useRef, useState } from 'react'

type Account = { login: string; active: boolean }

interface GithubAccountFieldProps {
  /** Undefined until gh answers, null when gh is missing. */
  accounts: Account[] | null | undefined
  login: string | null
  onPick: (login: string) => void
  /** Called after a login through gh succeeds, to re-read the accounts. */
  onConnected: () => void
  hint: string
}

/**
 * Picks one of gh's accounts, or — with none logged in — connects one right here through
 * `gh auth login --web`: main hands back the one-time code, this shows it, and the field turns into
 * the picker once gh reports the login stored.
 */
export default function GithubAccountField({
  accounts,
  login,
  onPick,
  onConnected,
  hint
}: GithubAccountFieldProps): React.JSX.Element | null {
  const [code, setCode] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const pending = useRef(false)

  // A login still polling when the dialog goes away would otherwise run on for its full fifteen minutes.
  useEffect(
    () => () => {
      if (pending.current) void window.maestro.repos.githubLoginCancel()
    },
    []
  )

  const connect = async (): Promise<void> => {
    setConnecting(true)
    setError(null)
    pending.current = true
    const started = await window.maestro.repos.githubLogin()
    if ('error' in started) {
      pending.current = false
      setConnecting(false)
      setError(started.error)
      return
    }
    setCode(started.code)
    const ok = await window.maestro.repos.githubLoginWait()
    pending.current = false
    setConnecting(false)
    setCode(null)
    if (ok) onConnected()
    else setError('GitHub login did not finish. Try again.')
  }

  const cancel = (): void => {
    void window.maestro.repos.githubLoginCancel()
  }

  const open = async (): Promise<void> => {
    if (!code) return
    await navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false)
    )
    await window.maestro.repos.githubOpenDevice()
  }

  if (accounts === undefined) return null

  if (accounts === null) {
    return (
      <div className="field">
        <label>GitHub account</label>
        <span className="field__hint">`gh` is not installed. Run `brew install gh`, then reopen this.</span>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="field">
        <label>GitHub account</label>
        {code ? (
          <div className="gh-connect">
            <div className="gh-connect__code" aria-label="One-time code">
              {code}
            </div>
            <div className="field__row">
              <button className="btn btn--primary" onClick={() => void open()}>
                <i className="ph ph-arrow-square-out" style={{ fontSize: 15 }} />
                {copied ? 'Code copied. Open GitHub' : 'Copy code and open GitHub'}
              </button>
              <button className="btn btn--ghost" onClick={cancel}>
                Cancel
              </button>
            </div>
            <span className="field__hint">
              <span className="spinner" /> Waiting for you to approve on GitHub…
            </span>
          </div>
        ) : (
          <>
            <div className="field__row">
              <button className="btn" onClick={() => void connect()} disabled={connecting}>
                {connecting ? <span className="spinner" /> : <i className="ph ph-github-logo" style={{ fontSize: 15 }} />}
                Connect GitHub
              </button>
              <span className="field__hint">No account connected yet</span>
            </div>
            {error && <span className="field__hint field__hint--error">{error}</span>}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="field">
      <label>GitHub account</label>
      <div className="seg seg--lg" role="group" aria-label="GitHub account">
        {accounts.map((a) => (
          <button
            key={a.login}
            className={`seg__opt${login === a.login ? ' is-on' : ''}`}
            aria-pressed={login === a.login}
            onClick={() => onPick(a.login)}
          >
            {a.login}
          </button>
        ))}
      </div>
      <span className="field__hint">{hint}</span>
    </div>
  )
}
