---
name: delegate
description: Hand a coding task to the AgentDeck daemon instead of doing it in this session, and the rules for working with a task's worktree. Use when a task could run unattended, when the user says delegate, queue it or give it to AgentDeck, or when testing, fixing or opening a task that AgentDeck ran.
---

# Delegate to AgentDeck

AgentDeck runs queued tasks unattended with `claude -p`, one git worktree per task, paced to the user's quota. This session designs the work; the daemon carries it out.

## Delegate or do it here

Suggest delegating when all of these hold:

- The task is self-contained: one repo, one branch, one PR.
- The repo's `test_cmd` and a written definition of done can check it.
- It needs no decisions from the user along the way.
- The user isn't waiting on it.

Do it in this session when it's small (a few minutes of work), exploratory, needs back-and-forth with the user, or changes the code of AgentDeck's live daemon (see "AgentDeck itself" below).

Never queue without asking. Say why the task fits, what you'd queue (title, model, plan or not), and wait for the user's OK. Queueing spends quota and opens PRs that nobody watches.

## Check the repo

```sh
agentdeck repo ls
```

The repo must be registered (`agentdeck repo add <path>`). Workers run in Claude Code's sandbox: by default, no network and no writes outside the worktree. Before queueing, check that the task can be done under those limits:

- **New dependencies:** a worker can't install a new package. Add it on the task's branch yourself first, or leave it out of the task. The daemon's `setup_cmd` installs only what the lockfile already lists.
- **Network:** tests that call a host need it in the repo's network list (`agentdeck repo set <repo> network "<hosts>"`). Ask before widening that list.
- **`.claude/`:** Claude Code won't let a worker edit anything under `.claude/` (skills, settings), even in its worktree. Make those edits yourself, before queueing or on the task's branch afterwards, and say so in the prompt (task #37 blocked on this).
- **Tests the sandbox breaks:** a test that needs something the sandbox refuses (such as `ps`) fails inside it. The worker reports it and finishes; AgentDeck's own test run outside the sandbox is the real check.

## Write the plan

Anything bigger than a one-line change gets a plan first. Settle it with the user in this session.

1. Write it to `docs/plans/<short-name>.html` in the plan format (`docs/plan-format.md` in the AgentDeck repo: the `data-agentdeck-plan="1"` marker, a `<p data-plan-summary>`, and one `<section data-plan-step id="…" data-status="todo">` per step, each with a `<ul data-plan-done>` list of its checks).
2. Commit it to the base branch as its own commit, so the task's branch starts with it.

## Queue the task

```sh
agentdeck add "<prompt>" --repo <repo> --title "<title>" [--model sonnet] [--max-turns n] [--attempts n] [--after <task>]
```

- **Prompt:** write it in these sections, in this order, each headed by its name. The planner writes its proposals the same way (`PROMPT_SECTIONS` in `daemon/src/domain/planner/plan.ts`).

  ```
  Goal: what the task achieves, in a sentence or two.
  Context: the files to start from, why it is needed, related tasks or plans.
  Change: what to do.
  Out of scope: what not to touch.
  Constraints: limits the agent must keep to, such as no new dependencies or no changes to package.json.
  Definition of done: the test command passing, plus concrete checks a reviewer can confirm.
  ```

  Leave out a section only when it would be empty. The prompt should read well as a ticket.

- **Plan:** link the task to it with `--plan docs/plans/x.html --steps a,b` (step ids; without `--steps`, every step not yet done or skipped). The plan must be committed to the base branch first. The daemon puts the linked steps' text and done criteria into the worker's prompt, so a linked task's prompt has only Goal, Out of scope and Constraints; the steps supply Change and Definition of done.
- **Model and turns:** the defaults are `sonnet` and 40 turns. Use `haiku` only for mechanical work. Raise `--max-turns` for multi-step plans (120 for a large port).
- **`--after`:** use it when the task builds on another task's branch being merged.

To show the plan on the task's Overview before its first run, `agentdeck attach <id> docs/plans/<short-name>.html`. It's stored under its path, so the branch's copy replaces it once a run changes it.

Tell the user the task id and stop. Don't poll it: AgentDeck notifies the user, and the user reviews the PR in the dashboard. In a later session, look only when asked: `agentdeck ls --status needs-you`, `agentdeck show <id>`, `agentdeck log <id>`.

## Working with a task's worktree

Each task runs in `~/.agentdeck/worktrees/<Repo>/task-<id>`, on the branch `agentdeck/task-<id>`, with dependencies installed. `git -C <repo> worktree list` shows which tasks still have one.

- **While it runs, don't touch it.** Edits beside the agent fight over the same files and commits, and the run's test results stop meaning anything. To change direction, `agentdeck cancel <id>`, or let it finish and retry with a note.
- **Test finished work in place,** in the task's worktree. Don't check the branch out in the main checkout: git refuses while the worktree exists, and the worktree already has its dependencies.
- **Small fixes:** commit them in the worktree and push them. A retry continues on the same branch, so your commit stays.
- **Anything bigger** goes back to the worker: `agentdeck retry <id> --note "<what to change>"`. If the fix would need explaining, it's a retry.
- **When done:** `agentdeck merge <id>` merges the PR and removes the worktree. `agentdeck clean <id>` removes a worktree without merging (the branch is kept).

## AgentDeck itself

When the repo is AgentDeck, the launchd daemon runs the main checkout's `daemon/src/cli.ts`. So:

- **Keep the main checkout on `main`.** Switching branches there swaps the running daemon's code, and with `reload_on_change` on, it restarts onto that code.
- **Do daemon changes in this session only when they're small and urgent.** Otherwise delegate them, and try them from the task's worktree.
- **Try a branch away from the live daemon:**
  - Dashboard-only change: from the worktree, run the dashboard's dev server against the live daemon on port 4317.
  - Daemon change: from the worktree, start a separate daemon with its own home and port (`AGENTDECK_HOME=$(mktemp -d) AGENTDECK_PORT=4318 node daemon/src/cli.ts daemon`), and run the dashboard with `VITE_AGENTDECK_API=http://127.0.0.1:4318`. Never point a branch's daemon at `~/.agentdeck`.
