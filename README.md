# Maestro

A desktop app for running and managing Claude Code agent sessions in parallel. Each session gets
its own git worktree, its own branch, and a **real Claude Code terminal** — not a chat wrapper.

Above the repos sits **Local**: a folder to work in with no repo behind it, for the things that are
not a feature branch. Say what you are working on and Maestro makes the folder — under
`~/maestro/local`, beside the worktrees it cuts — hands Claude your message, and names the session
from Claude's summary of it, exactly as a repo session does. Or point it at a folder you already
have, which keeps the name you give it — as many sessions as you like, since a second one in the
same folder adds `.claude/rules/maestro-shared-folder.md` telling every agent there to mind the
others, and removes it again when one is left. Same terminal, same editor, no worktree and no branch, so
reaching for a separate terminal outside Maestro is not the only option.

Every tab in a session — Claude, the editor, each console, each script's output — **drags into a
pane of its own**. Drop one against the edge of a pane to split it, on another pane's strip to join
it, and drag the edge between two panes to size them: halves, quarters or any mix, per session. A
pane keeps whatever is running in it across the move, because rearranging moves rectangles and never
the panes themselves. The header offers the way back to one pane once there is more than one.

Two deliberate bets, from [`PLAN.md`](./PLAN.md):

1. **The real terminal.** A `claude` PTY rendered with xterm.js. Plan mode, rewind, `/cost`, slash
   commands, hooks and every future Claude Code feature render natively, with zero integration work.
2. **A full embedded VS Code.** code-server in a webview supplies editing, search,
   go-to-definition, linting, the diff editor and the whole git UI. We delegate IDE depth
   rather than rebuilding it.

## Running it

```bash
npm install     # also rebuilds node-pty against Electron's ABI
npm run dev     # or: npm run build && npm start
```

Requires `claude` on `PATH`. Optional: `code-server` for the embedded editor, `gh` for PR creation.

macOS:

```bash
brew install code-server gh
```

Ubuntu (22.04 and 24.04) — the build toolchain for `node-pty`, then the optional tools:

```bash
sudo apt install build-essential python3 git
curl -fsSL https://code-server.dev/install.sh | sh
sudo apt install gh
```

On Ubuntu 24.04 an *unpackaged* run (`npm run dev`) can fail on Chromium's sandbox, because the
release restricted unprivileged user namespaces. Either make the bundled helper setuid once —

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

— or run with `--no-sandbox`. Installing the `.deb` does this for you, which is why it is the
recommended way to run Maestro rather than develop it.

### Packaging

```bash
npm run dist              # both
npm run dist -- mac       # just the .dmg
npm run dist -- linux     # just the .deb and .AppImage
```

Everything lands in `dist/`. Hand someone the `.dmg` for a Mac and the `.deb` for Ubuntu. The Linux
half builds in a container, so Docker has to be running; it is also the slow half by a wide margin,
which is the reason for the `mac` argument.

**Architecture.** The Mac half builds for the Mac you are on, so an Apple Silicon build will not
run on an Intel Mac — that needs `npx electron-builder --mac --x64`. The Linux half builds x86_64,
which is what desktop Linux overwhelmingly is; on an Apple Silicon Mac that means emulation, and it
is why it takes so much longer than the Mac half. `ARCH=arm64 npm run dist -- linux` builds native
instead, for an arm64 Linux machine. Nothing warns you if you pick wrong — the artifact simply does
not run.

(`linux/test.sh` on its own defaults to *this* machine's architecture rather than x86_64. The two
want opposite things: testing wants the fast native build, distribution wants what the recipient
has.)

**The Mac build is signed ad-hoc, not with a Developer ID.** It has no Apple certificate and is
not notarized, so the first launch on someone else's Mac is refused: right-click the app and
choose *Open*, then *Open* again in the dialog — or `xattr -dr com.apple.quarantine
/Applications/Maestro.app`. Only that first launch needs it. Ad-hoc signing is what makes even
that possible: unsigned, an Apple Silicon Mac reports the app as damaged and offers no way in.
`identity` and the entitlements in [`build/`](./build/README.md) exist for this; a real Developer
ID would replace both, and is the only way to make the warning go away.

**Installing it:**

```bash
sudo apt install ./maestro_0.1.0_amd64.deb   # Ubuntu
```

Whoever installs it needs `claude` on their PATH and signed in — Maestro runs Claude Code, it does
not bundle it — plus `git`. `code-server` and `gh` are optional, for the editor tab and PRs.

Native modules are compiled per platform, so a Linux build has to happen on Linux — see
`linux/test.sh` below for doing that from a macOS checkout. The `.deb` is the better of the two
targets on Ubuntu: its `postinst` sets `chrome-sandbox` up correctly, so 24.04's user-namespace
restriction is a non-issue, and it declares `git` and the Electron libraries as dependencies. The
`.desktop` entry it installs is `io.github.drbamba.maestro.desktop`, which the app announces itself as
([`index.ts`](./src/main/index.ts)) so the dock lights up the launcher rather than adding a second
nameless icon beside it.

The app icon lives in [`build/`](./build/README.md): `icon.svg` is the master — variant 6a from the
*Maestro Icon* Claude Design project — and the PNGs beside it are rendered from it by
`linux/test.sh icon`. macOS's `.icns` and Linux's `hicolor` set are both built from those at package
time.

### Testing on Linux from a Mac

```bash
npm run e2e:linux        # the full Playwright suite, on Ubuntu 24.04, under Xvfb
linux/test.sh build      # typecheck + build only
linux/test.sh dist       # produce the AppImage and .deb
linux/test.sh shell      # a prompt inside the container
```

This launches the real app — real Electron, real PTYs, real X server — inside an Ubuntu container,
against the same `out/` build that ships. It covers everything that actually differs between the
two platforms bar one: how the window looks. The chrome is native there and Maestro's own on macOS
(see `data-platform` in [`main.tsx`](./src/renderer/src/main.tsx)), so judging *that* still means
installing the `.deb` on a desktop VM.

## Getting about

Shift widens the jump: brackets alone move inside the session, and with shift they move between them.

| | |
| --- | --- |
| `⌘[` `⌘]` | previous / next tab in the focused pane |
| `⌘⇧[` `⌘⇧]` | previous / next session |
| `⌘1`…`⌘8`, `⌘9` | a session by position; `⌘9` is the last one |
| `⌘⇧←→↑↓` | the pane in that direction |
| `⌘⇧A` | the next session asking for you, or finished unread |
| `⌘K` `⌘N` | palette, new session |

Inside the editor pane, tab and session jumps still work. `⌘⇧arrows` and `⌘K` stay VS Code's.

On Linux, Ctrl stands in for ⌘, except the bracket chords: `Ctrl+[` is Escape in a terminal.

## Setup scripts

A fresh worktree has no `node_modules` and no `.env`, so most repos need something run in it before
the work can start. That something is **`.maestro/setup.sh`, committed to the repo** — so a clone from
zero already knows how to build itself. A new colleague adds the repo, cuts a session, and the
worktree comes up ready without being told what to run.

Write it like any other file in the repo: the file-code button in the session header (or ⌘K → **Edit
setup script**) creates it in the current worktree if the branch has none and opens it in the
embedded editor, whose workspace is that worktree — so `mise.toml`, `package.json` and everything
else it needs to quote is in the file tree beside it. Then commit and merge it as usual.

A worktree runs the copy its own tree carries; nothing reaches in from outside it. So what a branch's
setup does is whatever that branch says, and a base ref from before the script existed has none.
⌘K → **Run setup script** runs it again in the worktree you're in, which is how you check the one you
just wrote without cutting a session to find out.

It runs in a terminal tab of its own, so a failure is visible rather than swallowed. Claude's opening
turn waits for it, and so does any run script asked for meanwhile — an agent turn against a half-built
tree is the thing worth preventing. Nothing else waits. For setup nothing depends on — warming a
cache, pulling images — a line in the script releases the wait:

```bash
# maestro: background
```

## Design

The UI is an implementation of `Maestro.dc.html` from the *# Agentic IDE desktop app* Claude Design
project, built on the **Nocturne** design system. Nocturne's tokens are ported verbatim into
[`src/renderer/src/styles/theme.css`](./src/renderer/src/styles/theme.css) — the ramps, the 0.70×
spacing scale, 8px radii, Inter, Phosphor icons, outlined primary actions, and rules that fade to
transparent at their ends. The `--shell-*` layer on top is the darker app chrome the design uses so
the terminal and editor read as the brightest surfaces on screen.

## Architecture

```
src/main/        Electron main — services and IPC
  git.ts         worktrees, session-scoped status, integrate, land, gh PR/checks
  pty.ts         node-pty manager, output batched across the IPC boundary
  sessions.ts    worktree lifecycle, local folders, setup scripts, claude launch, archive
  agentState.ts  Claude Code hooks → working / attention / done / API error
  codeServer.ts  one shared code-server, one folder per editor tab
  store.ts       repos, sessions and settings persisted for restore on relaunch
src/preload/     typed contextBridge surface (window.maestro)
src/renderer/    React UI
  lib/layout.ts  the pane tree: splits, tab groups, and the rectangles they draw as
  TabBoard.tsx   draws that tree — strips, dragging, and the edges between panes
src/shared/      types shared across all three
```

### Open questions this resolves

`PLAN.md` §7 left eight questions to the design phase. Where the implementation takes a position:

| # | Question | Resolution |
|---|---|---|
| 1 | Agent state detection | **Claude Code hooks.** Each worktree gets `.claude/settings.local.json` hooks that append one word to a per-session state file; the app watches it. Hooks are a stable contract, unlike ANSI output — see [`agentState.ts`](./src/main/agentState.ts). |
| 2 | Merge-back UX | **Rebase by default**, merge-commit offered. Conflicts stop in place and offer two exits: open in the embedded editor, or hand the file list to Claude. |
| 3 | PR/CI depth | **`gh` CLI.** No OAuth app; `gh pr create` and `gh pr view --json statusCheckRollup` for the check dots. |
| 4 | Run-script output | **A terminal tab per script**, not a bespoke panel. Setup scripts run in their own tab so failures are visible. |
| 5 | Worktree location | `~/maestro/<repo>/<slug>`, outside the primary clone. Archive removes the worktree and keeps the branch unless asked otherwise. |
| 6 | VS Code sidebars | Our Changes/Git panels stay the glance surface; **Open SCM** and **Commit graph** hand off into the embed by delivering the real key events to the guest. |
| 7 | Commit-graph extension | **Git Graph** (`mhutchie.git-graph`), installed best-effort before the first editor tab loads — alongside Python (`ms-python.python`) and **basedpyright**, the language server, since Pylance cannot be installed outside Microsoft's builds. `python.languageServer` is set from what actually installed, so basedpyright and the pack's bundled Jedi are never both live. Extensions install *before* code-server starts: its extension host scans them once and then lives for the whole run. |
| 8 | App name | **Maestro.** |

## Status

Phases 0–3 of `PLAN.md` §8 are implemented in the shell: sessions and worktrees, the Claude
terminal, terminal tabs the user arranges into panes, changes list/tree, the editor embed,
merge-back, PR creation, state indications with sound and dock badge, and the ⌘K palette.

Settings holds one app-wide choice so far, reachable from the sidebar gear or the palette: **start
every session in auto mode**, which launches `claude --permission-mode auto` so Claude approves its
own tool use instead of stopping at each prompt. The same box sits in the launcher, where the
decision is actually being made. Left off, Maestro passes no mode at all — deliberately not the
default mode by name — so `defaultMode` in your own `.claude/settings.json` still decides. Mode is
fixed when the process starts, so it reaches sessions started afterwards; `shift+tab` still switches
mode inside a running one.

Not yet built: the cross-repo dashboard home view, per-repo run scripts (the data model carries them;
nothing edits them yet — setup scripts left the store entirely and became a file in the repo, see
above), and session archive/restore beyond the current worktree lifecycle.
