---
name: triage
description: Work through the AgentDeck tasks that wait on a person, one at a time, proposing an action for each and acting on the person's OK. Use when the user says triage, what needs me, go through the queue, unblock things, or clear the needs-you list.
---

# Triage the queue

Tasks wait on a person in three ways: proposals to approve, tasks that are blocked, failed or stuck, and PRs to review. The dashboard's "need you" chip counts all three.

```sh
agentdeck ls --status needs-you    # blocked, failed, and queued tasks whose dependency won't arrive (stuck)
agentdeck ls --status proposed
agentdeck ls --status review       # done, with an open PR
```

Take them one at a time, most urgent first: needs-you, then review, then proposals. For each, read `agentdeck show <id>`, then say in two or three lines what is wrong and what you'd do. Act only on the person's OK; every action below changes the queue. Batch them only when the person says so ("approve all the docs ones").

## Blocked

The reason is the line after the status. A `NEEDS` reason is what the worker asked for:

- **NEEDS deps:** `agentdeck install-needs <id>` installs the packages on the task's branch and retries it. Check that the packages make sense first.
- **NEEDS host:** the repo's network list (`agentdeck repo set <repo> network "<hosts>"`). Ask before widening it.
- **NEEDS edit** of files the worker can't write, usually under `.claude/`: retrying won't help. Make the edits in this session. If that was all of the task, reject it (it was session work); if not, push the edits to its branch and retry it.
- **A conflict** with the base that a resolve run couldn't settle: settle it in the worktree (`git merge origin/<base>`, fix, test, commit, push), then `agentdeck retry <id>`, or retry with a note that names the conflicting files.
- **Anything else:** read `agentdeck log <id>`. Then retry with a note that answers what it asked, mark it done if the work is in fact finished (`agentdeck done <id> --note "…"`), or cancel it.

## Failed

Read the log to see why: out of turns, tests failing, an error. Then:

- out of turns: `agentdeck edit <id> --max-turns n`, then retry;
- a wrong approach: retry with a note;
- a task that shouldn't run: cancel it.

## Stuck

A queued task that builds on a task that failed, was rejected or had its PR closed. Retry that task, unlink the two (`agentdeck unlink <id> <task>`) if the code isn't needed after all, or cancel.

## Review

Use the `review-task` skill. If the only problem is conflicts, `agentdeck sync <id>`. When several are clean and the person wants them in, `agentdeck merge --all`.

## Proposals

Read the prompt against the repo's goals (`agentdeck goals <repo>`) and the code. Approve (`agentdeck approve <id>`), reject, or edit and then approve. Proposals that depend on work that hasn't landed can wait: say what they wait for.

End with what changed and what is still waiting, in a few lines.
