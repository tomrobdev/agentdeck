# AgentDeck

Always-on agent manager for macOS. A background daemon works through a queue of coding tasks with Claude Code (`claude -p`), one git worktree per task, paced to stay within your subscription usage. A Tauri + Vue app is the control panel.

## Quick start

Needs Node 24+ (runs the TypeScript directly), git, and a logged-in `claude` CLI.

```sh
cd daemon && npm install && npm link     # puts `agentdeck` on your PATH

agentdeck repo add ~/code/myproject --test "npm test"
agentdeck add --repo myproject "Add input validation to the signup form, with tests"
agentdeck resume                          # the daemon starts paused
agentdeck daemon                          # foreground; or `agentdeck run-once`

agentdeck ls                              # queue
agentdeck show 1                          # runs, branch, worktree, final message
agentdeck log 1                           # readable transcript of the latest attempt
agentdeck status                          # slots, counts, 5h / 7d usage from Claude
```

Try it on a throwaway project first: `scripts/make-demo-repo.sh` creates one at `~/.agentdeck/demo-repo`.

## How a task runs

1. The scheduler claims the highest-priority queued task when a slot is free and it isn't paused or rate limited.
2. The task gets a worktree at `~/.agentdeck/worktrees/<repo>/task-<id>` on branch `agentdeck/task-<id>`.
3. `claude -p` runs there with `--permission-mode dontAsk`, the repo's allowed tools, and a turn limit. The stream-json output goes to `~/.agentdeck/logs/`.
4. Uncommitted leftovers get committed, then the repo's test command runs.
5. The outcome is **done** (branch ready to review), **blocked** (the agent ended with `STATUS: BLOCKED: …`, or changed nothing), or **failed** (retried until `max_attempts`). A retry reuses the branch, and the new prompt includes the last attempt's result.
6. A rate-limit rejection requeues the task without spending an attempt and holds the queue until the window resets.

Every run records tokens, and Claude's `rate_limit_event` gives live 5-hour and 7-day utilization. Milestone 3's governor will pace work using these.

## Layout

```
daemon/   Node + TypeScript: SQLite queue, scheduler, workers, CLI   (done)
app/      Tauri 2 + Vue 3 dashboard                                  (next)
launchd/  plist to keep the daemon running                           (milestone 4)
```

`cd daemon && npm test` runs the end-to-end tests with real git worktrees and a fake `claude` binary.

## Milestones

1. ~~Daemon core + CLI (queue, worker, worktrees)~~
2. Tauri + Vue dashboard
3. Usage governor + notifications
4. Planner + always-on (launchd, launch at login)

## Safety defaults

- Max 2 concurrent tasks
- Never pushes or merges; branches are left for review
- Per-repo allowed-tools list, no `--dangerously-skip-permissions`
- Daemon starts paused
