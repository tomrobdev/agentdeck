---
paths:
  - 'daemon/src/adapters/**'
---

# Working in `adapters/`

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **`adapters/` hold the I/O, in a folder per system they talk to.** (`rule:adapters-io`)
  - The folders: `claude/` (claude, run logs), `process/` (process groups, the shell), `git/` (git, split into `exec`, `refs`, `diffs` and `worktrees`, and the workspace), `github/`, `macos/` (keep-awake, notify, launchd, source watcher) and `local/` (goals, plan and protected-edit files, the daemon's own API and log).
  - They import `domain/` and `config.ts` only, never `db/` or `application/`: they report through callbacks like `runClaude`'s `onUsage`.
  - A git or `gh` call that reaches a remote never prompts (a credential prompt would hold a slot forever) and times out.
  - A sync is always a merge, never a rebase.
  - An error never quotes a command's arguments.
- **Every `claude` runs in its own process group** with its pid recorded on the run, so crash recovery can stop it. (`rule:claude-process-group`)

## How to

- An adapter is one file per thing it talks to, in the folder of its system; `compose.ts` wires it to its port in `application/ports/`.
- A test of an adapter uses the real tool (git in a temporary repo) or the fakes in `daemon/test/fixtures/`, never a mock of each call.
- Write no code comment but the file's leading one-line comment (`rule:code-comments`).
