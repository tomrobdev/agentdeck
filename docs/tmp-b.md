# ADR 0001: Run worker shell commands in Claude Code's sandbox

Status: accepted, 2026-10-18

## Context

Workers run `claude -p --permission-mode dontAsk` with an allow list of tool rules. The rules decide which
commands may _start_, not what those commands then do. Rules such as `Bash(node *)` and `Bash(pnpm run *)`
let a worker run any code: it writes a `.mjs` file or a `package.json` script, then runs it. So "no network,
no push, stay in the worktree" was only a convention. `Bash(git push*)` in the disallowed tools stops the
literal command, not `node -e` doing the same thing.

## Options considered

1. **Tighter tool rules.** Drop `node *` and `pnpm run *`. Breaks most repos' test and build scripts, and
   every allowed interpreter is still a way out. Rejected.
2. **A container or VM per run.** Strong isolation, but it needs Docker or a VM image on the user's Mac and
   repo toolchains inside it. It would be a large new runtime dependency. Rejected for now.
3. **Wrap `claude` in `sandbox-exec` ourselves.** We would have to write and maintain Seatbelt profiles,
   a network proxy and the git-worktree exceptions. Claude Code already ships all of this.
4. **Claude Code's built-in Bash sandbox** (Seatbelt on macOS, `@anthropic-ai/sandbox-runtime`). The OS
   confines every Bash command and its children. Writes may go only to the working directory (plus the
   shared `.git` of a linked worktree, without its `hooks/` and `config`) and the temp dir. Network goes
   through a proxy that checks an allow list. **Chosen.**
