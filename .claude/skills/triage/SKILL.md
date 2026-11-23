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
- **NEEDS edit** of files the worker can't write, usually under `.claude/`: retrying won't help. Make the edits in this session. If that was all of the task, mark it done with a note that says where the work landed (`agentdeck done <id> --note "…"`); if not, push the edits to its branch and retry it.
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

## Verify findings

The dashboard's "Fix with Claude" on the Verify run card passes a task id. The outcome is a prompt that is right, agreed with the person; approving the task stays their call.

1. `agentdeck show <id>` prints the prompt, each verify run's findings, and a line when the base has moved on since. Use the last verify run. If it is stale, check each finding against the current base before relying on it.
2. A finding can be wrong too: read the file it names. For each claim that isn't true, say what you'd change in the prompt, or why you'd leave it. Ask the person about anything the code can't settle, such as an open decision the prompt waits on.
3. Show the whole new text, and write it only on the person's OK:
   - **A task with an issue:** edit the issue, never the task. Read the body with `gh issue view <n> --json body --jq .body`, and start from that: the prompt also has a "Context" section with the parent issue's body, which doesn't belong in this issue. A finding about the parent's text is fixed in the parent issue, with its own OK. Read the body again right before writing; if it changed since you read it, stop and redraft. Then `gh issue edit <n> --body-file <file>`. The task follows at the next poll.
   - **Any other task:** `agentdeck edit <id> --prompt "…"`.
4. Once the task shows the new prompt, offer to verify it again (`agentdeck verify <id>`).

End with what changed and what is still waiting, in a few lines.

## On an issue-backed repo

On a repo with `issues` in `agentdeck repo ls`, GitHub is where a person answers, so act on the issue rather than the task, and the issue keeps the history:

- **Proposals** are the repo's open issues with none of the daemon's labels, not tasks in `proposed`: `gh issue list --search '-label:ready-for-agent -label:needs-info -label:"agentdeck:running"'`. That list also holds issues whose task blocked, failed or was cancelled (the daemon takes its labels off, and says so in a comment): those are below. Approve one with `gh issue edit <n> --add-label ready-for-agent`; reject one by closing it as not planned (`gh issue close <n> --reason "not planned"`).
- **Blocked with a question** (the issue has `needs-info`): reply on the issue (`gh issue comment <n>`), then put `ready-for-agent` back. The retry takes the comments since as its note.
- **Blocked or failed otherwise:** the same, with a comment that says what to change. `agentdeck retry` works too but leaves the issue out of it.
- **Cancel:** close the issue (`--reason "not planned"`), or take its label off while the task is still queued.
- **Review and merge** are as on any repo; the daemon closes the issue when the PR merges.
