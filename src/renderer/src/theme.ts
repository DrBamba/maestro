import { THEMES, type ThemeName } from '@shared/theme'
import type { ITheme } from '@xterm/xterm'

/**
 * The resolved theme, available synchronously because preload already asked for it.
 *
 * Waiting for the snapshot instead meant the window opened dark and turned white a frame later, on
 * every launch, for anyone who had chosen light. `prefers-color-scheme` looked like the answer —
 * main pins nativeTheme.themeSource to the preference before the window exists — but Chromium here
 * still reports the OS appearance regardless, so the media query would say light on a light Mac
 * whatever the app had been told.
 */
export function initialTheme(): ThemeName {
  return window.maestro.initialTheme
}

/**
 * xterm draws into a canvas of its own and cannot read a CSS custom property, so the terminal is
 * handed the same tokens the shell reads from theme.css, as literals.
 *
 * Built per call rather than memoised: it is asked for once at mount and once per theme change,
 * and an object xterm keeps is not one to share between terminals.
 */
export function terminalTheme(name: ThemeName): ITheme {
  const tokens = THEMES[name]
  return {
    background: tokens.embed,
    foreground: tokens.text,
    cursor: tokens.accent,
    cursorAccent: tokens.embed,
    selectionBackground: tokens.terminalSelection,
    ...tokens.ansi
  }
}
