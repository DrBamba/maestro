/*
 * Kept free of imports so the e2e suite can read the list without loading Electron.
 */

/**
 * Extensions the embed already has the first time an editor tab opens, rather than the reader
 * meeting a Python file with nothing but the built-in grammar behind it and having to go find
 * an extension themselves inside a workbench we deliberately stripped.
 *
 * - Git Graph is the commit graph PLAN.md open question 7 asks for — on Open VSX, and light.
 * - `ms-python.python` is an extension pack, so the CLI brings the debugger and the environment
 *   picker with it — including the interpreter discovery every Python tool here depends on.
 * - basedpyright is the language server. Pylance, the one most people mean, is proprietary and
 *   cannot be installed outside Microsoft's own builds, which leaves the pack falling back to the
 *   jedi-language-server it bundles. Jedi navigates, but infers nothing from types; basedpyright
 *   is Pyright, the engine the rest of the Open VSX world uses, and it reads a typed monorepo
 *   properly. Its unresolved-import diagnostics are the honest signal a worktree was never synced.
 */
export const EXTENSIONS = ['mhutchie.git-graph', 'ms-python.python', 'detachhead.basedpyright']
