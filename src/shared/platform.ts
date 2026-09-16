/**
 * The one place that asks what operating system this is.
 *
 * Maestro is a thin shell over other people's tools — a login shell, git, `claude`, code-server —
 * and every real difference between macOS and Linux is a difference in where those live or in how
 * the window manager expects to be treated. Scattering `process.platform === 'darwin'` through the
 * code buries those decisions; naming them here keeps them findable and reviewable, and means the
 * renderer can ask the same question the main process does.
 */
export type Platform = 'mac' | 'linux' | 'windows'

export function platformOf(nodePlatform: string): Platform {
  if (nodePlatform === 'darwin') return 'mac'
  if (nodePlatform === 'win32') return 'windows'
  return 'linux'
}

/**
 * The shell to fall back to when `$SHELL` is unset — a bare `execve` environment, a stripped
 * container, some launchers. Guessing zsh on Ubuntu means the terminal fails to open at all, since
 * zsh is not installed there by default; bash is present on both, so it is the safer miss.
 */
export function fallbackShell(platform: Platform): string {
  return platform === 'mac' ? '/bin/zsh' : '/bin/bash'
}

/**
 * Directories a package manager is likely to have put a tool in, that a GUI launch will not have
 * on PATH. Homebrew on macOS; on Linux the same three habits — Homebrew's Linux prefix, snap, and
 * the distro's own /usr/local — plus `~/.local/bin`, which every platform uses and which is where
 * `claude` installs itself.
 */
export function likelyToolDirs(platform: Platform, home: string): string[] {
  const shared = [`${home}/.local/bin`, '/usr/local/bin']
  if (platform === 'mac') return ['/opt/homebrew/bin', '/opt/homebrew/sbin', ...shared]
  return [...shared, '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', '/usr/bin']
}
