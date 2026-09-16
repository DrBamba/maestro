/**
 * Waits for Claude to title a freshly created session's conversation, then hands that title over as
 * the session's name.
 *
 * Claude Code writes an `ai-title` entry into its transcript a few lines into every conversation —
 * a short summary of the opening message, which since sessions carry their first prompt is exactly
 * the work the session is for. So there is no model to call and no credential to hold: this watches
 * for a file to gain a line.
 *
 * Polling rather than fs.watch: the history directory does not exist until Claude starts, and
 * watching a directory that is not there yet throws. A handful of small reads over a minute is
 * cheaper than the bookkeeping to watch for the parent appearing first.
 */

// Type-only, so this stays free of a runtime cycle with sessions.ts — which imports the watcher.
import type { TitleAttempt } from './sessions'

const POLL_MS = 2000

/**
 * How long to wait for a title *once a conversation has begun*, which is not the same as since
 * Claude started.
 *
 * A session whose first message is typed into Claude rather than passed at launch has an empty
 * transcript for as long as the user takes to write it. Measured from launch, this window expired
 * while they were still typing and the session kept its handle for good. The clock therefore does
 * not start until the transcript has something in it, and until then the poll simply keeps looking.
 */
const GIVE_UP_AFTER_MS = 2 * 60 * 1000

interface Watch {
  timer: NodeJS.Timeout
  /** When the first exchange appeared. Null while nothing has been said yet. */
  spokeAt: number | null
}

class TitleWatcher {
  private watches = new Map<string, Watch>()
  private apply: ((sessionId: string) => Promise<TitleAttempt>) | null = null
  private onNamed: (() => void) | null = null

  /** Wired at startup so this module stays independent of the session store and IPC. */
  configure(apply: (sessionId: string) => Promise<TitleAttempt>, onNamed: () => void): void {
    this.apply = apply
    this.onNamed = onNamed
  }

  /** Idempotent: relaunching a session that is already being watched changes nothing. */
  start(sessionId: string): void {
    if (this.watches.has(sessionId) || !this.apply) return
    const timer = setInterval(() => void this.tick(sessionId), POLL_MS)
    // Unreferenced so a pending poll can never hold the process open at quit.
    timer.unref?.()
    this.watches.set(sessionId, { timer, spokeAt: null })
  }

  private async tick(sessionId: string): Promise<void> {
    const watch = this.watches.get(sessionId)
    if (!watch) return

    let attempt: TitleAttempt
    try {
      attempt = (await this.apply?.(sessionId)) ?? 'done'
    } catch (err) {
      // Naming is cosmetic; a failure here must never disturb a running session.
      console.error('[autoTitle] naming failed', err)
      this.cancel(sessionId)
      return
    }

    if (attempt === 'named') {
      this.cancel(sessionId)
      this.onNamed?.()
      return
    }
    if (attempt === 'done') {
      this.cancel(sessionId)
      return
    }

    /*
     * Nothing said in this worktree yet, so nothing is overdue: keep looking, however long the
     * user spends on their first message. The watch is bounded by the session instead of by a
     * clock — disposing of one cancels it, and quitting stops them all.
     */
    if (attempt === 'idle') return

    /*
     * Give up quietly. A conversation Claude never titles — one interrupted before its first
     * exchange completed — simply keeps the handle it was created with, which is a working name.
     */
    watch.spokeAt ??= Date.now()
    if (Date.now() - watch.spokeAt > GIVE_UP_AFTER_MS) this.cancel(sessionId)
  }

  cancel(sessionId: string): void {
    const watch = this.watches.get(sessionId)
    if (!watch) return
    clearInterval(watch.timer)
    this.watches.delete(sessionId)
  }

  stop(): void {
    for (const id of [...this.watches.keys()]) this.cancel(id)
  }
}

export const titleWatcher = new TitleWatcher()
