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

## Dashboard (Tauri + Vue)

`agentdeck daemon` also serves a local API on `http://127.0.0.1:4317`, which the dashboard uses. It accepts browser requests only from the Tauri webview and the Vite dev server.

```sh
cd app && npm install
npm run tauri dev                                  # native window with hot reload
npm run tauri build -- --bundles app               # → src-tauri/target/release/bundle/macos/AgentDeck.app
npm run dev                                        # or just the UI in a browser at http://localhost:1420
```

The dashboard has the queue (Active / Needs you / Done), task detail with every run and its final message, a live log streamed over SSE, a pause/resume toggle, 5h/7d usage meters, and forms for new tasks and repos. Closing the window hides it to the menu-bar tray, and the daemon keeps working either way.

> **macOS 27 SDK linker error?** If Rust linking fails with `tapi error: malformed file … unknown architecture arm64e.x1-macos`, your Command Line Tools ship a newer SDK than their linker understands. Build against the 26.5 SDK: `export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.

## How a task runs

1. The scheduler claims the highest-priority queued task when a slot is free and it isn't paused or rate limited.
2. The task gets a worktree at `~/.agentdeck/worktrees/<repo>/task-<id>` on branch `agentdeck/task-<id>`.
3. `claude -p` runs there with `--permission-mode dontAsk`, the repo's allowed tools, and a turn limit. The stream-json output goes to `~/.agentdeck/logs/`.
4. Uncommitted leftovers get committed, then the repo's test command runs.
5. The outcome is **done** (branch ready to review), **blocked** (the agent ended with `STATUS: BLOCKED: …`, or changed nothing), or **failed** (retried until `max_attempts`). A retry reuses the branch, and the new prompt includes the last attempt's result.
6. A rate-limit rejection requeues the task without spending an attempt and holds the queue until the window resets.

## Usage governor

Every Claude run reports live 5-hour and 7-day utilization (`rate_limit_event`). Before starting new work, the scheduler asks the governor:

| Setting | Default | Effect |
|---|---|---|
| `five_hour_soft` | 60% | Above this, run one task at a time |
| `five_hour_max` | 85% | Above this, hold new tasks until the 5h window resets |
| `weekly_max` | 80% | Never plan past this share of the 7-day window |
| `pace_slack` | 10% | How far ahead of even pace it may run |

Weekly pacing is linear. The allowance grows from 0 at the start of the 7-day window to `weekly_max` at reset, plus the slack. If you're ahead of pace, queued work waits until the allowance catches up, and the dashboard shows when that will be. Running tasks are never interrupted, and the headroom stays free for your own interactive Claude use.

Change these in the dashboard's Settings, or with `agentdeck set weekly_max 0.7`. `agentdeck settings` shows the current decision.

## Notifications

The daemon sends a notification when a task finishes as done, blocked or failed (retried failures don't notify), and when the governor starts holding queued work. These arrive even when the dashboard is closed.

- **macOS:** on by default (`agentdeck set notify_desktop off`).
- **Phone:** set an [ntfy](https://ntfy.sh) topic in Settings, or with `agentdeck set ntfy_topic <topic>`, and subscribe to it in the ntfy app. Task titles go to ntfy.sh, so use a topic that's hard to guess.
- Choose events with `agentdeck set notify_events blocked,failed,hold`. `agentdeck notify-test` sends a test.

## Layout

```
daemon/   Node + TypeScript: SQLite queue, scheduler, workers, CLI, local API
app/      Tauri 2 + Vue 3 dashboard
launchd/  plist to keep the daemon running                           (milestone 4)
```

`cd daemon && npm test` runs the end-to-end tests with real git worktrees and a fake `claude` binary.

## Milestones

1. ~~Daemon core + CLI (queue, worker, worktrees)~~
2. ~~Tauri + Vue dashboard~~
3. ~~Usage governor + notifications~~
4. Planner + always-on (launchd, launch at login)

## Safety defaults

- Max 2 concurrent tasks
- Never pushes or merges; branches are left for review
- Per-repo allowed-tools list, no `--dangerously-skip-permissions`
- Daemon starts paused
