# Mission: Agentic IDE Desktop App

> **Purpose of this file.** This is the mission and scope document. It records what we're building, the decisions already made, the full feature inventory, and pointers for the design phase. It deliberately does **not** contain UI design or implementation detail — a separate design doc will be written later using this file as its input. Where a surface should look like an existing product, this file names the product to take inspiration from instead of describing the design.

---

## 1. Mission

Build a desktop app for running and managing Claude Code agent sessions in parallel — in the same product category as Conductor (by Melty Labs) — but with two deliberate improvements over it:

1. **The real Claude Code terminal, not a custom chat** — Conductor wraps the agent in a custom chat UI. We display the actual Claude Code terminal inside the app. This means every Claude Code feature (plan mode, rewind/checkpoints, `/cost`, hooks, slash commands, future features) works automatically, forever, with zero integration work per feature.
2. **A full embedded VS Code** (code-server) — real editing, file/text search, go-to-definition/usages, linting, diff editor, and git control inside the app, instead of Conductor's lighter viewing surfaces. We delegate IDE depth rather than rebuilding it.

---

## 2. Locked decisions

These were discussed and decided. Do not revisit them in the design phase without a strong reason.

| Decision | Choice | Rationale |
|---|---|---|
| App architecture | **Standalone Electron app** | Full control over look & feel (the point of the project). Electron is VS Code's own stack, so every hard problem we have (xterm.js at scale, node-pty, webviews) has a reference implementation. Heavier than native/Tauri, accepted tradeoff for build speed, ecosystem, and future Windows/Linux support. |
| Editor | **Embedded code-server / openvscode-server in webview tabs** | Full VS Code editing, file/text search, go-to-definition/usages, linting, and diff editor come free. We do not build Monaco+LSP ourselves. |
| Editor depth | Full IDE-lite in-app; **"Open in VS Code" deep link** as escape hatch for advanced needs (debugging, extensions the embed lacks) | |
| Agent support | **Claude Code only** | Agent-agnosticism conflicts with the raw-terminal approach (auto-supporting all features of one terminal is the point). Keep session/terminal plumbing reasonably generic, but do not design for other agents. |
| Git UI | **Delegated to the embedded VS Code** — built-in SCM view for staging/commit/branch ops, plus a commit-graph extension (e.g., Git Graph / GitLens from Open VSX) | No custom git UI (graph, branch switcher) built in our shell. Decided explicitly; revisit only if the owner says so. The shell keeps lightweight git *awareness* (branch names, changed-file counts, merge-back flow — §3.3). |
| Target OS | **macOS first**, Windows/Linux plausible later (an argument for Electron) | |
| Not building | Custom chat UI, our own LSP integration, our own diff editor | See §5 non-goals |

---

## 3. Feature inventory

### 3.1 Sessions & worktrees (core loop) — inspiration: Conductor

- **Repo management**: add repos; sessions/workspaces are grouped under their repo (Conductor's model — one workspace per feature, grouped by repo).
- **Session creation**: creating a session creates a git worktree on its own branch and launches Claude Code in it. Fast, low-friction — this is the most-used action in the app.
- **Worktree lifecycle**: create, list, archive/delete; cleanup of branch + worktree when a session ends.
- **Per-repo setup script**: runs on worktree creation (install deps, copy `.env`, etc.). Essential for worktrees to be usable at all.
- **Per-repo run scripts**: named scripts (dev server, tests) launchable per session.
- **Session end-of-life / merge-back**: in-app rebase/merge back to main, conflict surfacing, worktree cleanup, **PR creation**, and basic PR/CI status. (Conductor does review → PR → merge in-app; we match that.)

### 3.2 Terminal layer

- **The Claude terminal is the centerpiece**: a real PTY running `claude`, rendered with xterm.js (WebGL renderer). Not a chat wrapper. All Claude Code UI (plan mode prompts, rewind, slash commands) renders natively.
- **Regular terminal tabs** per session/worktree — inspiration: Conductor's terminal windows / VS Code's integrated terminal.
- **Agent state detection**: the app must know when Claude is *working / waiting for input / done* to drive indications (§3.5) and the dashboard. Note for design/implementation: since we display a raw terminal, state detection needs a mechanism — Claude Code hooks (e.g., Stop/Notification hooks), OSC sequences, or output heuristics. This is a key technical design question (§7).

### 3.3 Git — delegated to the embedded VS Code

Provided by the embed, not built by us:

- **Branch switching, commit, pull/push, fetch, stash, branch create/delete** — VS Code's built-in SCM UI.
- **Commit graph** — via an Open VSX extension (Git Graph or GitLens), pre-installed/configured by the app. Verify extension availability and quality during implementation.
- **Diff viewing and staging** (including per-hunk) — VS Code diff editor + SCM view.

What the shell still owns (git *awareness*, not git *UI*):

- **Changes view**: changed files as **flat list AND directory tree** (toggle) — Conductor does this well; keep it. Clicking a file opens the embedded VS Code diff editor.
- **Session-level git state**: branch name, ahead/behind, changed-file count on session cards and dashboard.
- **Merge-back + PR flow** (§3.1) — this is a session-lifecycle feature, not a git-UI feature, and stays ours.

### 3.4 Editor (embedded VS Code) — free features, listed for completeness

Provided by code-server/openvscode-server embed, not built by us:

- File editing, file/text search (incl. project-wide), go to definition/usages/references, symbol navigation, linting/diagnostics, diff editor, SCM staging UI.
- **Files list view** of the worktree lives in our shell (Conductor-style), opening files into embedded editor tabs.
- **"Open in VS Code"** button (file or worktree, at line) for anything the embed can't do.

### 3.5 Indications & notifications — inspiration: Conductor (does this well)

- **Completion sound** when an agent finishes.
- **Clear UI state indications** per session: working / needs attention / done — visible in the sidebar and dashboard at a glance.
- **OS notifications** and **dock badge count** for sessions needing attention (extends Conductor's pattern).

### 3.6 Shell UX

- **Overall UI design**: Conductor's design quality is the bar; take inspiration from its layout (sidebar of repos → sessions, main area per session).
- **Dashboard home view**: all sessions across all repos with live states — the "mission control" screen.
- **Command palette** (cmd+K style): keyboard-first navigation and actions.

---

## 4. Features intentionally delegated to the embedded Claude terminal

These exist in the product but require **zero app work** — the terminal provides them. The app must not duplicate them:

- Checkpoint / rewind
- Cost & usage (`/cost`, statusline)
- Plan mode, model switching, slash commands, hooks configuration, MCP management
- All future Claude Code features (this is the strategic payoff of the raw-terminal decision)

---

## 5. Non-goals

- **No custom chat UI** for the agent. Ever. That's the anti-Conductor bet.
- **No custom git UI** (branch switcher, commit graph, staging) — the VS Code embed + extensions provide it. Explicitly decided; the owner will say so if this changes.
- **No own Monaco/LSP/linting integration** — the VS Code embed provides it.
- **No multi-agent support** (Codex/Gemini CLIs) in scope. Conductor added Codex; we consciously don't follow.
- **No debugging support** in-app — escape hatch to full VS Code.
- Not GitHub-only by design if avoidable, but GitHub is the only forge that gets PR/CI integration initially (Conductor is GitHub-only; matching that scope is acceptable for v1).

## 6. Design-phase inspiration map

When the design doc is written, take inspiration per surface rather than inventing from scratch:

| Surface | Take inspiration from |
|---|---|
| Overall layout, sidebar, session cards, sounds/indications | Conductor |
| Changes list/tree toggle | Conductor |
| Terminal tabs | VS Code integrated terminal |
| Dashboard | Conductor's unified dashboard; also mission-control-style agent dashboards |
| Command palette | VS Code / Raycast / Linear |

## 7. Technical notes & open questions (for design + implementation phases)

**Notes (positions we lean toward, verify during implementation):**

- **One shared code-server process**, with each editor tab pointing at a different worktree folder — rather than one server per session — to control memory.
- xterm.js with the **WebGL renderer**; batch PTY output across the IPC boundary.
- Theming: our shell theme and the embedded VS Code theme (its own theme JSON) must be kept visually coherent — one seam to actively manage. Same for the keybinding/focus seam between shell and webviews.
- Light git data for the shell (branch names, changed counts, merge-back) via library or `git` CLI parsing — small surface now that graph/staging UI is delegated.
- Session persistence: app restart must restore repos, sessions, worktrees, and reattach or restart Claude terminals (`claude --resume`/`--continue`) — decide the mechanism.

**Open questions to resolve in the design phase:**

1. Agent state detection mechanism (hooks vs OSC vs heuristics) — affects reliability of indications, sounds, and dashboard. Likely candidate: Claude Code hooks writing to a file/socket the app watches.
2. Exact merge-back UX: rebase vs merge default, how conflicts hand off (open conflicted files in embedded editor? send Claude to fix them?).
3. PR/CI integration depth for v1 (`gh` CLI vs GitHub API vs OAuth app).
4. Where run-script output lives (terminal tab per script? dedicated panel?).
5. Worktree location convention and what "archive" means (Conductor keeps only tracked files in worktrees — same?).
6. How the embedded VS Code's SCM/file-explorer sidebars coexist with our shell's changes/files views (they now serve as the primary git UI, so they must be reachable — how prominently?).
7. Which commit-graph extension (Git Graph vs GitLens vs other) — check Open VSX availability, licensing, and how it looks embedded.
8. App name.

## 8. Suggested phasing (indicative, not a schedule)

- **Phase 0 — skeleton**: Electron shell, one repo, create worktree + session, Claude terminal in xterm.js, regular terminal tabs. *Prove the terminal feels great — it's the centerpiece.*
- **Phase 1 — core loop**: repo/session sidebar, setup scripts, changes list/tree, embedded code-server editor + diff + git (SCM view, graph extension), completion sound + state indications.
- **Phase 2 — lifecycle**: merge-back flow, worktree cleanup, PR creation + CI status, session persistence/resume.
- **Phase 3 — polish**: dashboard, command palette, run scripts, OS notifications/badge.
- **Later**: Windows/Linux, deeper review flows, anything cut above.
