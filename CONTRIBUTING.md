# Contributing to Maestro

Thanks for wanting to help. Maestro is a one-person project run in spare time, so here is how it
actually works.

## Before you start

- **Small fixes:** open a PR directly. Typos, clear bugs with an obvious fix, docs.
- **Anything bigger:** open an issue first and wait for a reply. A new feature, a change in
  behaviour, a refactor, another editor or agent harness. It saves you building something that
  won't be merged.
- **Questions and loose ideas:** use [Discussions](https://github.com/DrBamba/maestro/discussions),
  in Q&A or Ideas. Issues are for bugs and agreed work.
- **Security problems:** never in a public issue. See [SECURITY.md](./SECURITY.md).

Maestro is vibe-coded: most of it was written by Claude Code, and AI-written PRs are welcome too.
You are still responsible for what you submit. Read your diff, and run the checks below.

## Working on it

The quickest way is Maestro itself: add your clone as a repo and cut a session on it. See the
[Quick start](./README.md#quick-start).

[`CLAUDE.md`](./CLAUDE.md) holds the conventions, including the rules for UI copy. Agents working
in the repo read it automatically.

Before opening a PR:

```bash
npm run typecheck
npm run e2e        # builds, then drives the real app with Playwright
```

If you touched Linux behaviour, `npm run e2e:linux` runs the suite in an Ubuntu container.

## Pull requests

- One change per PR, with a description of what it does and why.
- Link the issue it closes.
- Add or update an e2e test for behaviour you changed.
- Keep the surrounding style: comment density, naming, and the copy rules in `CLAUDE.md`.

Only the maintainer merges. Reviews are best-effort. A PR that isn't
merged is not a judgement on you, and you are always free to keep it in your fork.

## License

By contributing you agree that your work is licensed under the [MIT License](./LICENSE).
