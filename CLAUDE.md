# Maestro

See [`README.md`](./README.md) for what this is and [`PLAN.md`](./PLAN.md) for why.

## Shipping to the running app

The user runs the installed Maestro while you edit its source. Your edits never reach it directly.
Try changes in your own `npm run dev` window, then merge to `main`. The running app then offers
**Update Maestro**, which builds, tests and applies `main` without touching any agent. Leave that
press to the user rather than running `npm run release` yourself.

## UI copy

Every string a user reads — modal notes, checkbox labels, hints, empty states, toasts, tooltips,
error messages — follows these rules. The default is a glance, not a paragraph.

**Budget.** Hints, labels, tooltips and empty states: one line, under about 12 words. Modal notes
and errors: two short sentences. Anything longer needs a reason, and the only reasons are: the
action destroys work, the action is irreversible, or the result would genuinely surprise someone
who read the short version. Even then, stop at three sentences.

**Say what happens, not why it works.** "Checks out `fix-login` in a new worktree" is copy. "git
allows one checkout per ref, so…" is a code comment. If a sentence explains the implementation
rather than the outcome, move it into the source and delete it from the screen.

**A side effect nobody acts on is not worth a sentence.** Files Maestro writes into its own
directories, processes it starts, state it tracks — true, and still cut. State a side effect only
when it lands somewhere the user owns, or when they would be startled to find it later.

**Don't reassure about a different screen.** A creation dialog does not explain what archiving
will keep. The archive dialog says that, at the moment it matters.

**Lead with the outcome.** The first clause is what the user gets. Mechanism only follows when the
user has to act on it.

**Cut the connective tissue.** No "so that…", "which means…", "rather than…", "there is nothing
extra to…". No chained em-dashes stacking three facts into one sentence. One idea per sentence,
one sentence per fact worth stating.

**Don't restate the control.** A button labelled "Delete" does not need a note that says deleting
happens. Say only what the label cannot.

**Reuse the app's own words.** If the button says "Archive", the note says "archiving" — not
"putting it away". Backtick real identifiers (`--continue`, `gh`, branch names) and let them carry
the specificity so the prose doesn't have to.

**Errors name the fix.** State what failed and the next action, nothing else. "`gh` is not
installed. Run `brew install gh` and `gh auth login`, then try again."

**Prompts are questions, not instructions.** "What are you building?" beats "Enter a description
of the work".

Before adding a string: write it, then delete every clause that does not change what the user
does next.
