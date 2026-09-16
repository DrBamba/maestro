/**
 * The theming seam PLAN.md §7 flags as the one to actively manage — now with two grounds.
 *
 * The shell reads theme.css and nothing else. The two embeds cannot: xterm takes a colour object
 * and code-server takes a settings file, both outside the document, so neither can see a CSS
 * custom property. This module is the one place all three agree — every value below is the literal
 * of a theme.css token, named for the role it plays in an embed, so changing a token there and
 * here changes the shell, the terminal and the editor together.
 */

export type ThemeName = 'dark' | 'light'

/** What the user chose. `system` follows the OS, resolved in main against Electron's nativeTheme. */
export type ThemePreference = ThemeName | 'system'

/** xterm's sixteen slots. */
export interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeTokens {
  /** --color-text */
  text: string
  /** --color-neutral-400 */
  textBright: string
  /** --color-neutral-500 */
  textMuted: string
  /** --color-neutral-700 */
  textFaint: string
  /** --color-accent */
  accent: string
  /** --color-accent-800 — a selection behind text that still has to be read. */
  accentSelection: string
  /** --color-accent-900 — the selected row in a list. */
  accentList: string
  /** --color-neutral-900 — the rules between one part of the workbench and the next. */
  line: string
  /** --color-neutral-800 — widget borders and the scrollbar slider. */
  lineStrong: string
  /** --shell-embed — the ground the terminal and the editor's text both sit on. */
  embed: string
  /** One step off that ground: the active line, and a row under the pointer. */
  embedLift: string
  /** --shell-bg — the shell chrome the embed is inset into, reused for the editor's own chrome. */
  chrome: string
  /** --shell-panel */
  panel: string
  /** --shell-overlay — floating widgets, quick input. */
  overlay: string
  /** --shell-toast — a list row under the pointer. */
  listHover: string
  /** --diff-add / --diff-del */
  diffAdd: string
  diffDel: string
  ansi: AnsiPalette
  /** Drawn over the embed ground, so it carries its own alpha rather than a flat colour. */
  terminalSelection: string
}

/**
 * Nocturne's ramps applied to the 16 ANSI slots — low chroma, accent for the cursor.
 */
const DARK_ANSI: AnsiPalette = {
  black: '#292b31',
  red: '#f0b5b5',
  green: '#b5f0c0',
  yellow: '#febc2e',
  blue: '#b5abfc',
  magenta: '#d2cefd',
  cyan: '#a8d8e8',
  white: '#cfd3e5',
  brightBlack: '#595d6c',
  brightRed: '#f5c9c9',
  brightGreen: '#c9f5d2',
  brightYellow: '#ffd479',
  brightBlue: '#cbc4ff',
  brightMagenta: '#e7e5fe',
  brightCyan: '#c6e6f2',
  brightWhite: '#f3f5fe'
}

/**
 * The same hues carried onto a white ground, which needs them darker rather than paler — a pastel
 * that reads as green on near-black is a smudge on paper.
 *
 * Two slots depart from the convention deliberately. `white` and `brightWhite` are mid-to-dark
 * greys, not the light ones a light terminal theme usually gives them: this terminal exists to be
 * read, and a coding agent narrating its work in bright white would otherwise write in invisible
 * ink. `brightBlack` keeps its usual job — the dimmer grey that comments and hints are printed in —
 * so "bright" means further from the ground everywhere except those two.
 */
const LIGHT_ANSI: AnsiPalette = {
  black: '#24262f',
  red: '#b3453f',
  green: '#2f7d4a',
  yellow: '#8a6100',
  blue: '#4437a3',
  magenta: '#7a4b9c',
  cyan: '#26707f',
  white: '#585c6a',
  brightBlack: '#8b8f9e',
  brightRed: '#c95a53',
  brightGreen: '#3d9a5e',
  brightYellow: '#a77a10',
  brightBlue: '#5b4fc4',
  brightMagenta: '#9560bb',
  brightCyan: '#348a9c',
  brightWhite: '#2f3340'
}

export const THEMES: Record<ThemeName, ThemeTokens> = {
  dark: {
    text: '#e9e9ed',
    textBright: '#b2b6ca',
    textMuted: '#9397ab',
    textFaint: '#595d6c',
    accent: '#9184d9',
    accentSelection: '#423a6a',
    accentList: '#2b2741',
    line: '#292b31',
    lineStrong: '#3f424d',
    embed: '#0a0a0d',
    embedLift: '#141418',
    chrome: '#0f0f13',
    panel: '#101015',
    overlay: '#17171c',
    listHover: '#1d1d24',
    diffAdd: '#86d29a',
    diffDel: '#e08a8a',
    ansi: DARK_ANSI,
    terminalSelection: 'rgba(145, 132, 217, 0.35)'
  },
  light: {
    text: '#16181f',
    textBright: '#454956',
    textMuted: '#585c6a',
    textFaint: '#9a9eac',
    accent: '#5b4fc4',
    accentSelection: '#ccc7f6',
    accentList: '#e8e5fc',
    line: '#e0e3ec',
    lineStrong: '#c8cbd7',
    embed: '#ffffff',
    /*
     * The embed is the brightest thing on screen in both themes — paper here, the darkest ground
     * there — so every other surface steps *away* from white rather than towards it.
     */
    embedLift: '#f4f5fa',
    chrome: '#f2f3f8',
    panel: '#eef0f6',
    overlay: '#ffffff',
    listHover: '#eceef5',
    diffAdd: '#2f7d4a',
    diffDel: '#b3453f',
    ansi: LIGHT_ANSI,
    terminalSelection: 'rgba(91, 79, 196, 0.22)'
  }
}
