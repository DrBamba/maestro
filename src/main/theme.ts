import { nativeTheme } from 'electron'
import type { ThemeName, ThemePreference } from '@shared/theme'
import { store } from './store'

/**
 * Where `system` stops being a possibility and becomes a colour.
 *
 * Only main can answer it — the shell, the terminal and the embedded editor would each have to ask
 * the OS separately and could disagree for a frame — so it is answered once here and the answer is
 * what everything else is given.
 */

export function themePreference(): ThemePreference {
  return store.preferences.theme ?? 'dark'
}

export function resolvedTheme(): ThemeName {
  const preference = themePreference()
  if (preference !== 'system') return preference
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * Mirrors the choice onto Electron itself.
 *
 * This is what the parts of the window we do not draw read: the traffic lights, the native message
 * boxes the quit confirmation and the crash dialog use, and the folder picker. Left alone they
 * would follow the OS while the app followed the setting, so choosing light on a dark Mac produced
 * a light app wearing dark window controls.
 */
export function syncNativeTheme(): void {
  nativeTheme.themeSource = themePreference()
}

/**
 * Calls back whenever the OS appearance changes, which is what makes a `system` preference live
 * rather than merely read once at launch.
 *
 * Deliberately unfiltered: nativeTheme also emits when we set themeSource ourselves, and the
 * caller already refuses to reapply a theme that is the one in place, so filtering here would only
 * be a second opinion about the same question.
 */
export function onSystemThemeChange(handler: () => void): void {
  nativeTheme.on('updated', handler)
}
