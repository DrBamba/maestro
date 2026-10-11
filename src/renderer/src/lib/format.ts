/** "12m", "2h", "3d" — the compact stamp the sidebar rows carry. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

export function aheadBehind(ahead: number, behind: number): string {
  return `↑${ahead} ↓${behind}`
}

export function filesChanged(count: number): string {
  return `${count} file${count === 1 ? '' : 's'} changed`
}

export function homeRelative(path: string, home: string): string {
  // Every string starts with the empty one, so an unset home would turn any path into "~<path>" —
  // a plausible-looking lie. Before the snapshot lands, the path is simply shown in full.
  if (!home) return path
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export function defaultPrTitle(sessionName: string): string {
  const trimmed = sessionName.trim()
  if (!trimmed) return 'Update'
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** "2 commits · 3 files since", or '' when nothing has happened on the branch since it landed. */
export function sinceLanding(commits: number, files: number): string {
  const parts = [commits && count(commits, 'commit'), files && count(files, 'file')].filter(Boolean)
  return parts.length ? `${parts.join(' · ')} since` : ''
}

/** Where a landing went, in the words the header chip and the row tooltip share. */
export function landedOn(where: 'remote' | 'local', ref: string): string {
  return where === 'remote' ? `On ${ref}` : `Merged into ${ref} · not pushed`
}
