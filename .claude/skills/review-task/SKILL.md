---
name: review-task
description: Review a finished AgentDeck task in a session: read its diff against its Definition of done and plan steps, test it in the task's worktree, then merge it, retry it with a note, or commit a small fix. Use when the user says review #12, check this task, is it ready to merge, or look at what the worker did.
---

# Review a task

A done task has a branch, usually an open PR, and a summary the worker wrote. Reviewing it means checking the work against what the task asked for, not against what the summary claims. The worktree rules (don't touch a running task, test in place, small fixes vs a retry) are in the `delegate` skill.

## 1. Read what was asked and what was done

```sh
agentdeck show <id>      # prompt, links, plan, each run's summary and tests
agentdeck review <id>    # reviews and line comments made in the dashboard
```

- The **Definition of done** is in the prompt; for a task linked to a plan, it is the linked steps' `<ul data-plan-done>` checks in the plan AgentDeck stores (`agentdeck show <id>` names it; the dashboard shows it on the task's Overview).
- Read the diff: `git -C ~/.agentdeck/worktrees/<Repo>/task-<id> diff origin/<base>...HEAD`, or `gh pr diff <url>` when the worktree is gone.
- Check each item of the Definition of done against the diff, one by one. Note what is missing, what is out of scope, and what breaks the repo's rules (its CLAUDE.md).
- A summary's "I didn't run the dashboard" or "one test fails in the sandbox" is a to-do for you, not a pass.

## 2. Test it in place

In the task's worktree, which has its dependencies installed:

- Run the repo's test command (`agentdeck repo ls` shows `test=`).
- Try the change for real where the Definition of done asks for it. For the AgentDeck dashboard, run the dev server from the worktree against the live daemon. For a daemon change, use a separate daemon with its own home and port, as `delegate` describes; never one on `~/.agentdeck`.

If the worktree is gone (`agentdeck clean`, or merged with cleanup), read the PR on GitHub instead, and say what you couldn't test.

## 3. Decide

Say what you found and what you'd do, and wait for the person's OK before any of these:

- **Merge:** `agentdeck merge <id>`. It shows the preview and refuses a PR that conflicts or lands after a task that hasn't landed. If the repo has auto-merge on and the check passes, the daemon may merge it on its own: say so if you want it held (`agentdeck auto-merge <id> off`).
- **Conflicts with the base:** `agentdeck sync <id>`. A clean merge needs no claude, and conflicts start a resolve run. Or settle them in the worktree yourself (`git merge origin/<base>`, fix, test, commit, push).
- **A small fix:** commit it in the worktree and push it. The PR gets it, and a later retry keeps it.
- **Changes needed:** `agentdeck retry <id> --note "<what to change, item by item>"`. The note goes first in the next run's prompt. If the fix would need explaining, it's a retry, not a fix of yours.
- **Not wanted:** `agentdeck close-pr <id>`. Tasks that build on it stay stuck until it is retried or they are cancelled.

After a merge, the tasks that build on it start on the scheduler's next tick; `agentdeck merge` names them.
