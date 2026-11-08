import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeUsage } from '@shared/types'

/** The endpoint is cached in main for a minute; this only decides how stale the ring may look. */
const POLL_MS = 5 * 60_000

/** Which band a fill falls in. The ring and the popover's bars share it. */
function level(percent: number): 'ok' | 'high' | 'full' {
  return percent >= 95 ? 'full' : percent >= 80 ? 'high' : 'ok'
}

/** "in 3h 6m" under a day, "Wed 11:00" past that. */
export function resetsIn(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `Resets in ${minutes}m`
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  const when = new Date(at)
  const day = when.toLocaleDateString(undefined, { weekday: 'short' })
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `Resets ${day} ${time}`
}

function Ring({ percent, tone }: { percent: number | null; tone: string }): React.JSX.Element {
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <svg className={`usage-ring is-${tone}`} width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle className="usage-ring__track" cx="9" cy="9" r={r} />
      {percent !== null && (
        <circle
          className="usage-ring__fill"
          cx="9"
          cy="9"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
        />
      )}
    </svg>
  )
}

/**
 * Claude's plan usage, at a glance in the sidebar footer: a ring filled to the limit nearest to
 * running out. Pressing it opens every limit with its reset time.
 */
export default function UsageRing(): React.JSX.Element {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(Date.now())
  const root = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (force = false) => {
    setLoading(true)
    try {
      setUsage(await window.maestro.agent.usage(force))
    } finally {
      setLoading(false)
      setNow(Date.now())
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    void refresh()
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      clearInterval(tick)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, refresh])

  const windows = usage?.ok ? usage.windows : []
  const top = windows.length ? Math.max(...windows.map((w) => w.percent)) : null
  const tone = top === null ? 'none' : level(top)
  const tip = usage?.ok
    ? windows.map((w) => `${w.label} ${w.percent}%`).join(' · ') || 'Claude usage'
    : usage
      ? usage.error
      : 'Claude usage'

  return (
    <div className="usage" ref={root}>
      <button
        className="icon-btn-bare usage__button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Claude usage"
        aria-expanded={open}
        data-tip={open ? undefined : tip}
      >
        <Ring percent={top} tone={tone} />
      </button>

      {open && (
        <div className="usage__pop" role="dialog" aria-label="Claude usage">
          <div className="usage__head">
            <span className="usage__title">Claude usage</span>
            {usage?.ok && usage.plan && <span className="usage__plan">{usage.plan}</span>}
          </div>

          {!usage && <div className="usage__note">Loading…</div>}
          {usage && !usage.ok && <div className="usage__note is-bad">{usage.error}</div>}
          {usage?.ok && !windows.length && <div className="usage__note">No limits reported.</div>}

          {windows.map((w) => (
            <div className="usage__row" key={w.label}>
              <div className="usage__line">
                <span className="usage__label">{w.label}</span>
                <span className="usage__pct">{w.percent}%</span>
              </div>
              <div className={`usage__bar is-${level(w.percent)}`}>
                <div className="usage__bar-fill" style={{ width: `${w.percent}%` }} />
              </div>
              {w.resetsAt && <div className="usage__reset">{resetsIn(w.resetsAt, now)}</div>}
            </div>
          ))}

          {usage?.ok && usage.extra && (
            <div className="usage__row">
              <div className="usage__line">
                <span className="usage__label">Extra usage</span>
                <span className="usage__pct">
                  {usage.extra.used}
                  {usage.extra.limit && ` / ${usage.extra.limit}`}
                </span>
              </div>
            </div>
          )}

          <div className="usage__foot">
            <span className={usage?.ok && usage.stale ? 'is-bad' : undefined}>
              {usage?.ok && usage.stale
                ? usage.stale
                : usage
                  ? `Updated ${new Date(usage.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
            </span>
            <button
              className="icon-btn-bare"
              onClick={() => void refresh(true)}
              disabled={loading}
              aria-label="Refresh usage"
              data-tip="Refresh"
            >
              <i className={`ph ph-arrow-clockwise${loading ? ' usage__spin' : ''}`} style={{ fontSize: 14 }} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
