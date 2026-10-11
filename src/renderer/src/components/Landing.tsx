import type { BranchSync, Landing } from '@shared/types'
import { landedOn, sinceLanding } from '../lib/format'

/**
 * A sidebar row's branch, at a glance: commits ahead while it is unmerged, a merge glyph once any
 * of it is on the base — green pushed, amber not — and what has happened on it since, in the
 * accent, because that is the work still left to land.
 */
export function SyncMark({ sync }: { sync: BranchSync | undefined }): React.JSX.Element | null {
  if (!sync) return null
  const { ahead, landing } = sync
  if (!landing) {
    if (ahead === 0) return null
    return (
      <span className="sync" data-tip={`${ahead} commit${ahead === 1 ? '' : 's'} ahead`}>
        <i className="ph ph-arrow-up" />
        {ahead}
      </span>
    )
  }
  const since = sinceLanding(landing.commitsAfter, landing.filesAfter)
  const where = landedOn(landing.where, landing.ref)
  return (
    <span
      className={`sync is-${landing.where}${since ? ' is-after' : ''}`}
      data-tip={since ? `${where} · ${since}` : where}
    >
      <i className="ph ph-git-merge" />
      {landing.where === 'local' && <i className="ph ph-arrow-up sync__small" />}
      {since && <span className="sync__after">+{afterGlyph(landing)}</span>}
    </span>
  )
}

function afterGlyph(landing: Landing): React.ReactNode {
  return landing.commitsAfter > 0 ? (
    landing.commitsAfter
  ) : (
    <i className="ph ph-pencil-simple sync__small" />
  )
}

/** Whether a row's work is all on origin with nothing since — finished, and safe to archive. */
export function isLanded(sync: BranchSync | undefined): boolean {
  const landing = sync?.landing
  return Boolean(
    landing && landing.where === 'remote' && !landing.commitsAfter && !landing.filesAfter
  )
}

/** The header's version, in place of ↑ ↓ once something has landed. */
export function LandingChip({ landing }: { landing: Landing }): React.JSX.Element {
  const since = sinceLanding(landing.commitsAfter, landing.filesAfter)
  return (
    <span className={`landing-chip is-${landing.where}`}>
      <i className="ph ph-git-merge" />
      {landedOn(landing.where, landing.ref)}
      {since && <span className="landing-chip__after">+{since}</span>}
    </span>
  )
}
