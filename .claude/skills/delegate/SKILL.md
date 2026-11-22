---
name: delegate
description: Decide whether to hand a coding task to the AgentDeck daemon instead of doing it in this session, what a worker can't do in its sandbox, and the rules for working with a task's worktree. Use when a task could run unattended, when the user says delegate or give it to AgentDeck, or when testing, fixing or opening a task that AgentDeck ran.
---

# Delegate to AgentDeck

AgentDeck runs queued tasks unattended with `claude -p`, one git worktree per task, paced to the user's quota. This session designs the work; the daemon carries it out.

- **One task:** the `add-task` skill interviews the person, writes the prompt and queues it.
- **A plan and several linked tasks:** the `write-plan` skill.
- **Reviewing what a task did:** the `review-task` skill.
- **A repo that takes its tasks from GitHub Issues** (`issues` in `agentdeck repo ls`): `agentdeck add` is refused, and a task is an issue labelled `ready-for-agent`. `add-task` and `write-plan` file the issues, and `triage` answers on them.

## Delegate or do it here

Suggest delegating when all of these hold:

- The task is self-contained: one repo, one branch, one PR.
- The repo's `test_cmd` and a written definition of done can check it.
- It needs no decisions from the user along the way.
- The user isn't waiting on it.

Do it in this session when it's small (a few minutes of work), exploratory, needs back-and-forth with the user, edits `.claude/` (see below), or changes the code of AgentDeck's live daemon (see "AgentDeck itself").

Never queue without asking. Say why the task fits, what you'd queue (title, model, plan or not), and wait for the user's OK. Queueing spends quota and opens PRs that nobody watches.

## What a worker can't do

```sh
agentdeck repo ls
```

The repo must be registered (`agentdeck repo add <path>`). Workers run in Claude Code's sandbox: by default, no network and no writes outside the worktree. Before queueing, check the task can be done under those limits:

- **New dependencies:** a worker can't install a new package. Add it on the task's branch yourself first, or leave it out of the task. The daemon's `setup_cmd` installs only what the lockfile already lists. A worker that blocks asking for one (NEEDS deps) can be unblocked with `agentdeck install-needs <id>`.
- **Network:** tests that call a host need it in the repo's network list (`agentdeck repo set <repo> network "<hosts>"`). Ask before widening that list.
- **`.claude/`:** Claude Code won't let a worker edit anything under `.claude/` (skills, settings), even in its worktree, and retrying doesn't help (tasks #37, #108 and #111 blocked on it). Make those edits in a session, before queueing or on the task's branch afterwards. A task that is only `.claude/` edits is session work: do it, then reject the proposal, or mark the task done with a note (`agentdeck done <id> --note "…"`) if it already ran and blocked.
- **Protected edits:** a worker writes the whole new file to `.agentdeck/edits/claude/<path>` instead, with the leading dot of `.claude` left off (a skill's SKILL.md goes under `skills/<name>/` in that folder). AgentDeck commits it to the branch after the run and a person reviews it before merging. It never applies the settings files or `.claude/hooks/`: a task that needs those blocks with `NEEDS edit`. The path-scoped guidance in `.claude/rules/` and the `model-change` skill are changed this way.
- **Work it can't see:** task branches start from `origin/<base>`. Push what the task needs first, or link it with `--builds-on` to the task that adds it.
- **Tests the sandbox breaks:** a test that needs something the sandbox refuses (such as `ps`) fails inside it. The worker reports it and finishes; AgentDeck's own test run outside the sandbox is the real check.
- **Code comments:** every repo has limits on the code comments a task's diff adds (`code_comment_max_lines`, `code_comment_max_percent`, set with `agentdeck repo set`). A run over them gets one resumed turn to delete them, and if it is still over its PR waits for a person. In AgentDeck itself no code comment is allowed outside what a tool reads (`rule:code-comments`), so say in the prompt that the worker writes none.

**Live state:** in a repo AgentDeck manages, a hook (`.claude/settings.json`, `agentdeck context --hook`) puts the queue's live state into every message: a header line, then what changed since your last message. Trust that over what you remember from earlier in the session, and run `agentdeck ls` again right before naming a task's state or using it in a link.

After queueing, tell the user the task id and stop. Don't poll it: AgentDeck notifies the user, and the user reviews the PR in the dashboard. In a later session, look only when asked: `agentdeck ls --status needs-you`, `agentdeck show <id>`, `agentdeck log <id>`.

## Working with a task's worktree

Each task runs in `~/.agentdeck/worktrees/<Repo>/task-<id>`, on the branch `agentdeck/task-<id>`, with dependencies installed. `git -C <repo> worktree list` shows which tasks still have one.

- **While it runs, don't touch it.** Edits beside the agent fight over the same files and commits, and the run's test results stop meaning anything. To change direction, `agentdeck cancel <id>`, or let it finish and retry with a note.
- **Test finished work in place,** in the task's worktree. Don't check the branch out in the main checkout: git refuses while the worktree exists, and the worktree already has its dependencies.
- **Small fixes:** commit them in the worktree and push them. A retry continues on the same branch, so your commit stays. A conflict with the base can be settled the same way: `git merge origin/<base>` in the worktree, fix, test, commit, push.
- **Anything bigger** goes back to the worker: `agentdeck retry <id> --note "<what to change>"`. If the fix would need explaining, it's a retry.
- **When done:** `agentdeck merge <id>` merges the PR and removes the worktree. `agentdeck clean <id>` removes a worktree without merging (the branch is kept).

## AgentDeck itself

When the repo is AgentDeck, the launchd daemon runs the main checkout's `daemon/src/cli.ts`. So:

- **Keep the main checkout on `main`.** Switching branches there swaps the running daemon's code, and with `reload_on_change` on, it restarts onto that code.
- **Do daemon changes in this session only when they're small and urgent.** Otherwise delegate them, and try them from the task's worktree.
- **Try a branch away from the live daemon:**
  - Dashboard-only change: from the worktree, run the dashboard's dev server against the live daemon on port 4317.
  - Daemon change: from the worktree, start a separate daemon with its own home and port (`AGENTDECK_HOME=$(mktemp -d) AGENTDECK_PORT=4318 node daemon/src/cli.ts daemon`), and run the dashboard with `VITE_AGENTDECK_API=http://127.0.0.1:4318` and the same `AGENTDECK_HOME`, so the dev server finds that daemon's API token. Never point a branch's daemon at `~/.agentdeck`.
