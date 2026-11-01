---
name: daemon-debug
description: Find out what is wrong with the AgentDeck daemon and fix it safely, starting from `agentdeck doctor`. Use when the user says the daemon is stuck, down, not picking up tasks, not merging, a run hangs, the dashboard is offline or shows old code, or asks to restart the daemon.
---

# Debug the daemon

The daemon is a launchd service running `daemon/src/cli.ts` from the AgentDeck checkout, with its state in `~/.agentdeck/agentdeck.db` and its log in `~/.agentdeck/logs/daemon.log`. The CLI works without it, except for work that starts `claude` (propose, sync).

## 1. Start with doctor

```sh
agentdeck doctor
```

It checks the launchd service, the API, the code the daemon loaded against the checkout's HEAD, a pending reload, `claude` processes left over from a dead daemon, running tasks, recent errors in the log, and `gh` auth. Each failed check names the command that fixes it. Run that, then run doctor again. It works with the daemon down.

## 2. Waiting is not stuck

Most "nothing is happening" is a decision, not a fault. `agentdeck status` and the dashboard's wait bar say which:

- **Paused:** the daemon (`agentdeck resume`) or a repo (`agentdeck repo resume <repo>`; a repo is paused when its doctor failed, and the reason says why).
- **A hold:** the governor waits on the 5-hour or 7-day usage window. It lifts on its own; `agentdeck settings` shows the limits.
- **No free slot:** `max_concurrent` tasks are running.
- **A dependency:** a task that builds on another waits for it to merge. A stuck one (its dependency failed or was rejected) needs a person: retry the dependency, unlink, or cancel.
- **Auto-merge waiting:** `agentdeck show <id>` gives the reasons (conflicts, checks, the daemon paused). Conflicts are synced on their own only while the daemon isn't paused and the governor allows it.

## 3. Read the log

```sh
agentdeck logs -n 200     # or -f to follow
agentdeck log <id>        # one task's latest run; --attempt n for another
```

A `SyntaxError`, a missing export or "Merge conflict marker encountered" right after "source changed … exiting so launchd starts the new code" means the daemon reloaded onto code that was half written, or mid-merge or mid-rebase in the checkout. launchd restarts it; once the code is whole again, it starts. Nothing needs fixing if it is running now. Doctor's log check stays failed for 24 hours after the last error, and its "code loaded" check says which commit the daemon is on.

## 4. A run that hangs

- `agentdeck show <id>` shows a running task's turns and last tool. The dashboard's row shows them live.
- Every `claude` runs in its own process group, with its pid recorded on the run (it leads the group). `pgrep -lf -g <pid>` lists it and its children.
- To stop it: `agentdeck cancel <id>`. The task goes through `cancel_requested`, and the daemon stops the process group. Don't kill processes by hand while the daemon is up.

## 5. Restart safely

- `agentdeck restart` pauses new claims, waits until no task or planner run is active, restarts, and puts the pause state back. It costs nothing but the wait.
- `agentdeck restart --now` restarts at once. A running task is requeued, and its next run resumes the claude session where it can. Use it when a run hangs or a fix can't wait, and say what it interrupts.
- With `reload_on_change` on, the daemon restarts onto new `daemon/src` code by itself once nothing is running. Keep the checkout on `main`: switching branches there swaps the live daemon's code.
- Down altogether: `agentdeck service start`, or `agentdeck install` if the launchd plist is gone.

## Don'ts

- Never point a test daemon at `~/.agentdeck`. Use `AGENTDECK_HOME=$(mktemp -d) AGENTDECK_PORT=4318`.
- Never write a task's status in the database by hand. Every status change is a guarded event in `daemon/src/db/tasks.ts`. Use the CLI. `pnpm db:studio` is for reading.
