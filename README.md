# Maestro

> [!WARNING]
> **This is 100% vibe-coded.** Every line was written by AI agents, with minimal human review
> for quality or security. Nobody has audited it. Read the code before you trust it with your
> machine, and don't run it anywhere you would mind something going wrong. See
> [Security](#security).

A desktop app for running Claude Code sessions in parallel. Each session gets its own git
worktree, its own branch, a **real Claude Code terminal** and a **full VS Code editor**.

## Why Maestro

**How it started.** Maestro was born after I used more and more concurrent sessions, working on
more features at once instead of waiting for Claude to finish.

**Why not another app.** I tried other applications, but they did more than I wanted. They used
their own agent harness or their own code editor, which limited the results, because making each
of those great is a hard task on its own. So Maestro has:

- **Claude Code itself**, not some other harness on top of the model.
- **VS Code's editor**, with its git control and views and all the other great powers the editor
  gives.

In the future, I or someone making a PR may add other editors and agent harnesses. That is meant
to be fairly easy.

**The greatest feature.** While working on Maestro I discovered that its greatest feature is how
easily anything can be added, the moment I feel something is missing. For example, I hope to make
the sessions aware of each other, so they can:

- handle merging and conflicts without me,
- think about order and implications,
- and even orchestrate working together on features to accelerate the work.

**Why it's public.** I enjoy Maestro, and I hope others will enjoy it too and donate their
improvements, so that I and everyone else can enjoy it even more :)

[`PLAN.md`](./PLAN.md) has the original scope and the decisions behind it.

## What you get

- **One worktree per session.** Cut a session from any repo; Maestro makes the branch and the
  worktree, runs the repo's setup script, and starts `claude` in it.
- **See every agent at a glance.** The sidebar shows which sessions are working, which are asking
  for you, and which have finished.
- **Land the work.** Rebase or merge back onto the base branch, or open a PR with `gh`.

Runs on macOS and Ubuntu.

## Quick start

You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` on `PATH`,
signed in), `git`, and Node.js 22 or later.

```bash
git clone https://github.com/DrBamba/maestro.git
cd maestro
npm install
npm run dev
```

To install it as an app on an Apple Silicon Mac:

```bash
npm run install-stable   # builds the .dmg and copies Maestro.app into /Applications
```

To change Maestro itself, open the app, click **Add repo** and pick this clone. Sessions on it edit
your local copy. Merge one to `main` and press **Update Maestro** to run it.

From then on the installed app updates itself from this checkout's `main` — see
[Updating Maestro while it runs](#updating-maestro-while-it-runs). For a `.deb` or an Intel Mac, see
[Packaging](#packaging).

## Local sessions and panes

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

## Running it

```bash
npm install     # also rebuilds node-pty against Electron's ABI
npm run dev     # or: npm run build && npm start
npm run e2e     # build, then run the Playwright suite against the real app
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
([`app.ts`](./src/main/app.ts)) so the dock lights up the launcher rather than adding a second
nameless icon beside it.

The app icon lives in [`build/`](./build/README.md): `icon.svg` is the master, and the PNGs beside
it are rendered from it by
`linux/test.sh icon`. macOS's `.icns` and Linux's `hicolor` set are both built from those at package
time.

### Updating Maestro while it runs

Maestro is developed with Maestro, so the copy you are working in has to take changes without
being closed — and without running anything unfinished. The installed app follows `main` in the
checkout it was built from, wherever you cloned it.

- **While building a change:** `npm run dev` in the session's worktree opens a separate "Maestro
  Dev" window that updates on every save.
- **Once it is merged to `main`:** the running app shows **Update Maestro** above the sidebar
  footer. Pressing it builds `main` in a scratch worktree, runs the e2e suite against the build, and
  switches over. A change that only touches the window reloads it; one that touches main relaunches
  the app. Running agents carry on either way. If a dialog is open when the build finishes, the
  switch waits for it to close.

The button appears a moment after `main` moves: Maestro watches the file git writes for that ref,
and re-checks every minute in case a watch misses one. `main` moving locally — an agent merging, a
`git pull` — is what it reads. Settings adds the remote to that: with **Fetch Maestro's own
repository every five minutes** on, it fetches `origin` and fast-forwards a clean `main`, so an
update that landed there is offered here too.

Nothing is applied until the button is pressed. A failed build says whether it failed to build or
failed its tests, and offers the log and a retry. `npm run release` is the same pipeline from a
terminal (`--quick` runs only the live-update tests, `--no-tests` none — what **Skip tests when
updating** in Settings passes); what it publishes also waits for the button.

The rules that keep it unbroken:

- **Terminals live in a host process**, not in the app ([`ptyHost.ts`](./src/main/ptyHost.ts)). An
  update, a reload or a crash replaces the app around them. The next window reattaches and replays
  their recent output, and puts the tabs and panes back. Quitting still ends them.
- **Only tested commits ship.** Nothing runs from a checkout, so a half-saved file in any
  worktree cannot reach the app you are using.
- **A broken release backs itself out.** One that fails to load, or does not bring up a working
  window in time, is marked bad and the previous build comes back
  ([`index.ts`](./src/main/index.ts), [`updater.ts`](./src/main/updater.ts)).
- **Two agents cannot undo each other.** Updates come from `main`, so both agents' work is in them.
  Releases take turns, and one that does not contain the live release is refused.

A new terminal-host protocol (`HOST_PROTOCOL` in [`ptyProtocol.ts`](./src/main/ptyProtocol.ts))
cannot be applied live, since it means replacing the host and the agents in it; the button offers
**Restart to update** instead. A new runtime dependency needs `npm run install-stable` again:

```bash
cd path/to/maestro && git pull && npm run install-stable
```

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

The UI is built on the **Nocturne** design system. Nocturne's tokens are ported verbatim into
[`src/renderer/src/styles/theme.css`](./src/renderer/src/styles/theme.css) — the ramps, the 0.70×
spacing scale, 8px radii, Inter, Phosphor icons, outlined primary actions, and rules that fade to
transparent at their ends. The `--shell-*` layer on top is the darker app chrome the design uses so
the terminal and editor read as the brightest surfaces on screen.

## Architecture

```
src/main/        Electron main — services and IPC
  index.ts       boot loader: picks the installed build or a newer release, backs out a bad one
  app.ts         the app itself — window, lifecycle, quit
  updater.ts     switches the running app onto a newly published release
  ptyHost.ts     the terminal host: owns every PTY, outlives the app, replays output on reattach
  pty.ts         main's side of the host — spawn, reattach, relay to the window
  git.ts         worktrees, session-scoped status, integrate, land, gh PR/checks
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

## Security

Maestro has had no security review. Some of what it does by design:

- **Runs code from the repos you add.** A repo's `.maestro/setup.sh` runs in every new worktree,
  without asking.
- **Can let Claude act without asking.** With auto mode on, sessions start with
  `claude --permission-mode auto`.
- **Serves an editor with no password.** code-server listens on `127.0.0.1` with `--auth none`,
  so any process on your machine can reach it, terminal included.
- **Writes into your repos.** It adds `.claude/settings.local.json` hooks to each worktree, and a
  shared-folder rule to `.claude/rules/` in folders with more than one session.

Only add repos you trust. Please report security problems as GitHub issues, without exploit
details.

## Contributing

Issues and pull requests are welcome. [`PLAN.md`](./PLAN.md) explains what Maestro is for and the
bets it makes; [`CLAUDE.md`](./CLAUDE.md) holds the conventions agents working on it follow,
including the rules for UI copy. Run `npm run typecheck` and `npm run e2e` before opening a PR.

## License

[MIT](./LICENSE) © Raz Kafri
