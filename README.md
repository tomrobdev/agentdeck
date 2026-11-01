# AgentDeck

Always-on agent manager for macOS. A background daemon works through a queue of coding tasks with Claude Code (`claude -p`), one git worktree per task, paced to stay within your subscription usage. A Tauri + Vue app is the control panel.

## Quick start

Needs Node 24+ (runs the TypeScript directly), git, and a logged-in `claude` CLI.

```sh
pnpm install                             # whole workspace (app + daemon)
pnpm setup:cli                           # puts `agentdeck` on your PATH (~/.local/bin)

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
pnpm dev                                           # the service daemon (installed if needed) + native window; see "Developing the daemon"
pnpm dev:app                                       # just the window, against an already-running daemon
pnpm build                                         # → app/src-tauri/target/release/bundle/macos/AgentDeck.app
pnpm --filter agentdeck-app dev                    # or just the UI in a browser at http://localhost:1420
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

## Repo doctor and paused repos

```sh
agentdeck repo doctor myproject   # checks, each with a reason; exit code 1 if any fails. `repo add` runs it too.
agentdeck repo resume myproject   # let a paused repo's tasks run again
agentdeck edit 12 --max-turns 60  # change a proposed, queued, blocked or failed task
```

Doctor checks that the path is a git repo, the base branch exists (locally or as `origin/<base>`), a toolchain is detected or set, and `claude` is found. If the repo has a PR mode other than off, it also checks `gh auth status` and that `origin` exists. In a temporary worktree from the base branch, it runs the setup command and the test command, then checks that the repo's tool rules allow every command the test command runs. The worktree is removed afterwards, pass or fail.

A failed doctor **pauses the repo**: its queued tasks stay queued but aren't claimed, and you get a `hold` notification. A repo is also paused when a run's setup command fails (`setup failed on task #N`) or when a run ends blocked or failed after tool uses were refused (`permission refused on task #N: <command>`; the run records how many in `denials`). `repo ls`, the API and the Repos panel show the reason. `repo resume` clears it, and so does a passing doctor.

## Planner

Give a repo goals and AgentDeck proposes its own next tasks:

```sh
agentdeck goals myproject --file goals.md   # or edit ~/.agentdeck/goals/myproject.md, or use Repos in the dashboard
agentdeck plan myproject                    # run now; otherwise it runs when the repo's queue is empty
agentdeck approve 12 13                     # proposals wait for you…
agentdeck repo set myproject auto_approve on   # …unless you trust the planner on this repo
```

The planner runs `claude -p` read-only in the repo's main checkout. It reads the goals, the code, and the repo's open and recent tasks, then answers in a fixed JSON shape: up to `planner_max_tasks` (default 3) small tasks, each ending with a definition of done and a suggested model. Duplicates of existing tasks are dropped. It runs on its own only when a repo with goals has nothing open, at most every `planner_interval_hours` (default 3), and only when the governor allows work.

## Always on

```sh
agentdeck install      # launchd agent: starts at login, restarted within seconds if it dies
agentdeck service      # status
agentdeck service stop # unload the daemon but keep the plist; `service start` loads it again
agentdeck restart      # graceful: pause new claims, wait for running tasks and planner runs, restart, restore pause
agentdeck restart --now  # restart at once; a running task loses its run and is requeued
agentdeck logs -f -n 100  # print or follow ~/.agentdeck/logs/daemon.log
agentdeck uninstall    # unload and delete the plist
```

The agent runs `daemon/src/cli.ts` from this checkout, so keep the checkout on `main`. After pulling, `agentdeck restart` starts it on the new code. `pnpm reboot` and `pnpm logs` call `agentdeck restart` and `agentdeck logs -f` (run `pnpm setup:cli` once to put `agentdeck` on your PATH). While tasks or the planner run, the daemon holds a `caffeinate -i` assertion so the Mac doesn't idle-sleep; it releases it when idle. In the dashboard, Settings → Always on turns on "Open this dashboard at login" (menu-bar tray only), and the tray menu shows the daemon's state.

### Developing the daemon

`pnpm dev` uses the service daemon (it installs it if needed) and starts only the dashboard. To have the daemon pick up your edits, run `agentdeck set reload_on_change on` (or use the toggle in Settings → Always on). The daemon then watches `daemon/src`. Once a file has changed and no task or planner run is active, it logs why and exits, and launchd starts it again on the new code. While work runs it waits, and it claims no new tasks until it has reloaded. It is off by default, so a daemon running real tasks is never restarted by an unrelated edit.

## Usage governor

Every Claude run reports live 5-hour and 7-day utilization (`rate_limit_event`). Before starting new work, the scheduler asks the governor:

| Setting          | Default | Effect                                                |
| ---------------- | ------- | ----------------------------------------------------- |
| `five_hour_soft` | 60%     | Above this, run one task at a time                    |
| `five_hour_max`  | 85%     | Above this, hold new tasks until the 5h window resets |
| `weekly_max`     | 80%     | Never plan past this share of the 7-day window        |
| `pace_slack`     | 10%     | How far ahead of even pace it may run                 |

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
```

`pnpm test` runs the end-to-end tests with real git worktrees and a fake `claude` binary.

`pnpm test:crash [iterations]` (default 10, about 10 s each) is a slower check, not part of `pnpm test`: it SIGKILLs the daemon at random points, restarts it, and verifies that every task ends in a final state, no worktree ever has two agents, no `claude` process is orphaned, worktrees match tasks, and attempt counts are sane. It prints a one-line summary and exits 1 on any violation.

```sh
pnpm check:fast                                    # format check + typecheck + db:check + tests (the repo's test_cmd)
pnpm check                                         # check:fast + crash test (CRASH_ITERATIONS, default 10); what CI runs
pnpm format                                        # Prettier, whole repo
pnpm check:rust                                    # cargo fmt --check + clippy on the Tauri shell
```

## Milestones

1. ~~Daemon core + CLI (queue, worker, worktrees)~~
2. ~~Tauri + Vue dashboard~~
3. ~~Usage governor + notifications~~
4. ~~Planner + always-on (launchd, launch at login)~~

## Safety defaults

- Max 2 concurrent tasks
- Never pushes or merges; branches are left for review
- Per-repo allowed-tools list, no `--dangerously-skip-permissions`
- Daemon starts paused
