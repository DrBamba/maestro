import { useEffect, useState } from 'react'
import type { ClaudeLaunch, Conversation } from '@shared/types'
import { relativeTime } from '../lib/format'

interface ClaudeLauncherProps {
  sessionId: string
  /** Set when Claude exited rather than never having been started. */
  exitCode: number | null
  /** Set when Claude was killed here mid-task by a previous quit or crash. */
  interruptedAt?: number
  /** What this session's directory is, so the copy names it correctly. */
  place?: 'worktree' | 'folder'
  /**
   * The stored auto-mode setting, offered here as well as in Settings because this is where the
   * decision is actually being made. Unlike the fork box below it is not per-launch: permission
   * mode is app-wide, so ticking it here is the same act as ticking it there.
   */
  autoMode: boolean
  onAutoMode: (on: boolean) => void
  onLaunch: (launch: ClaudeLaunch) => void
}

/**
 * Shown over the Claude pane when no agent is running — either because Maestro did not create
 * this worktree and the user should choose which conversation to pick up, or because the process
 * exited and there would otherwise be no way back into it.
 *
 * Conversations are resumed by explicit id. `--continue` cannot be aimed at a particular
 * conversation, and it declines any that another Claude still holds open, which is exactly the
 * case for a worktree whose terminal session is still running. A live conversation is therefore
 * forked, leaving the original transcript untouched.
 */
export default function ClaudeLauncher({
  sessionId,
  exitCode,
  interruptedAt,
  place = 'worktree',
  autoMode,
  onAutoMode,
  onLaunch
}: ClaudeLauncherProps): React.JSX.Element {
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [forceFork, setForceFork] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setNow(Date.now())
    void window.maestro.agent.conversations(sessionId).then(setConversations)
  }, [sessionId])

  const visible = showAll ? (conversations ?? []) : (conversations ?? []).slice(0, 3)

  return (
    <div className="launcher">
      <div className="launcher__card">
        <div className="launcher__head">
          <i className={`ph ${exitCode === null ? 'ph-terminal-window' : 'ph-warning-circle'}`} />
          <div>
            <div className="launcher__title">
              {exitCode === null ? 'Start Claude' : 'Claude exited'}
            </div>
            <div className="launcher__sub">
              {exitCode === null
                ? `Pick up an existing conversation in this ${place}, or start a new one.`
                : exitCode === 0
                  ? 'The process ended. Resume where it left off or start fresh.'
                  : `The process exited with code ${exitCode}. Resume where it left off or start fresh.`}
            </div>
          </div>
        </div>

        {interruptedAt !== undefined && (
          <div className="modal__error">
            Claude was still working here when Maestro quit ({relativeTime(interruptedAt, now)} ago).
            The transcript stops mid-turn — check the last exchange before continuing.
          </div>
        )}

        {conversations === null && <div className="launcher__empty">Reading conversations…</div>}

        {conversations?.length === 0 && (
          <div className="launcher__empty">
            No stored conversations for this {place} yet.
          </div>
        )}

        {visible.map((conversation) => (
          <button
            key={conversation.id}
            className="launcher__row"
            onClick={() =>
              onLaunch({
                mode: 'resume',
                conversationId: conversation.id,
                /*
                 * Always attempt the real conversation, even when it looks live.
                 *
                 * Forking pre-emptively was worse than the problem it avoided: a fork opens under a
                 * new id with the history in context but a fresh screen, so picking the right
                 * conversation appeared to open an empty one. And "live" is only a recency
                 * heuristic — it fires for conversations nobody has open.
                 *
                 * Real contention is handled deterministically instead: Claude declines with
                 * "currently running as a background agent" and the exit handler retries as a fork.
                 * The checkbox below still forces it for anyone who wants a branch on purpose.
                 */
                fork: forceFork
              })
            }
          >
            <div className="launcher__row-main">
              <span className="launcher__row-title">
                {conversation.title || 'Untitled conversation'}
                {conversation.live && <span className="launcher__live">in use elsewhere</span>}
              </span>
              {conversation.lastPrompt && (
                <span className="launcher__row-prompt">{conversation.lastPrompt}</span>
              )}
            </div>
            <span className="launcher__row-meta">
              {conversation.messages} msgs · {relativeTime(conversation.updatedAt, now)}
            </span>
            <i className="ph ph-arrow-counter-clockwise" />
          </button>
        ))}

        {conversations && conversations.length > 3 && !showAll && (
          <button className="modal__link" onClick={() => setShowAll(true)}>
            show {conversations.length - 3} more
          </button>
        )}

        {/* Always offered, whether there is a conversation to pick up or not. */}
        <button
          className="checkbox"
          aria-label="Start Claude in auto mode"
          onClick={() => onAutoMode(!autoMode)}
        >
          <span className={`checkbox__box${autoMode ? ' is-on' : ''}`}>
            {autoMode && <i className="ph ph-check" />}
          </span>
          <span className="checkbox__label">
            Auto mode — Claude approves its own tool use. Applies to every session until you turn it
            off.
          </span>
        </button>

        {(conversations?.length ?? 0) > 0 && (
          <button className="checkbox" onClick={() => setForceFork((v) => !v)}>
            <span className={`checkbox__box${forceFork ? ' is-on' : ''}`}>
              {forceFork && <i className="ph ph-check" />}
            </span>
            <span className="checkbox__label">
              Fork into a copy instead of resuming — the original stays untouched. Not needed when a
              conversation is only open elsewhere.
            </span>
          </button>
        )}

        <div className="launcher__actions">
          <button className="btn btn--primary" onClick={() => onLaunch({ mode: 'new' })}>
            <i className="ph ph-plus" style={{ fontSize: 15 }} />
            New conversation
          </button>
          {(conversations?.length ?? 0) > 0 && (
            <button className="btn" onClick={() => onLaunch({ mode: 'continue' })}>
              <i className="ph ph-arrow-counter-clockwise" style={{ fontSize: 15 }} />
              Continue most recent
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
