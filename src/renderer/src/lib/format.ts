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
