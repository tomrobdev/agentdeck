---
name: add-task
description: Interview the person, then write and queue one well-formed AgentDeck task. Use when the user says add a task, write a task, queue this, make a ticket for it, file it as a proposal, or runs /add-task (the dashboard's "Write it with Claude" button runs it). For work that needs a plan and several linked tasks, use write-plan instead.
---

# Add a task

One task is one unit of work on one repo: one branch, one PR. This skill turns what the person wants into a task a worker can finish unattended, and queues it. Whether to delegate at all, and the sandbox limits, are in the `delegate` skill. If the work has several steps that should land separately, use `write-plan`. On a repo that takes its tasks from GitHub Issues (`issues` in `agentdeck repo ls`), the task is filed as an issue: see the last section.

## 1. Ask what and why

Ask what should change and why, in one question. Then stop asking and read: the code answers most of what a ticket needs.

## 2. Read the code

Find the files the change starts from, the code it must fit (rules in the repo's CLAUDE.md, existing helpers, tests), and anything related in the queue (`agentdeck ls <search>`). Ask the person only what the code can't answer: a product choice, a trade-off, what done looks like when the code doesn't say.

## 3. Write the four sections

Write the prompt in these sections, in this order, each as a `## ` heading (`PROMPT_SECTIONS` in `daemon/src/domain/work/task/prompt.ts` of the AgentDeck repo). Current problem and Expected outcome are required; leave out Out of scope or Constraints only when it would be empty. It should read well as a ticket. Say what is wrong and what done looks like, not how to do it: the worker reads the code and decides the how.

```
## Current problem
What is wrong or missing today, and where: the files, functions and screens.

## Expected outcome
- What a reviewer can check once it is done, one bullet each.
- The last bullet: the repo's test command passes.

## Out of scope
What not to touch.

## Constraints
Limits the agent must keep to, such as no new dependencies or no changes to package.json.
```

- **Paths in full, from the repo root:** `daemon/src/domain/work/task/task.ts`, not `domain/work/task/task.ts`. `agentdeck add` warns about every path the prompt names that isn't on the base branch, and a shortened path gives a false warning.
- **Every path on the base branch, or added by a task this one builds on.** Task branches start from `origin/<base>`, so work that is only committed locally, or only on another task's branch, isn't there. Push it first, or link the task with `--builds-on`.
- **Sandbox limits:** no new packages, no network unless the repo allows the host, nothing under `.claude/` (see `delegate`). If the task needs one of these, do that part yourself first or leave it out.

## 4. Choose model, turns and links

- **Model:** choose one for every task and pass it as `--model`. The rule: `opus` for subtle design, a wide change or anything a reviewer would struggle to check; `sonnet` for a well-specified change of a few files; `haiku` only for mechanical work (a rename, a wording sweep). Say which you chose and why when you show the task. Without `--model` the task takes the repo's model, else the `default_model` setting, and `agentdeck add` says which.
- **Turns:** the default is 40. Raise `--max-turns` for a change across many files (80), or a large port (120).
- **Links:** `--builds-on <task>` when this needs another task's code: it starts once that one is done and merged. `--after <task>` when it only has to land after it: it runs at once and only its merge waits. Run `agentdeck ls` right before naming a task in a link.
- **Auto-merge:** the repo's `auto_merge` setting applies. If the person wants to see the PR first, run `agentdeck auto-merge <id> off` after adding.

## 5. Show it, then queue

Show the title, the prompt, the model, turns and links. Queue only on the person's OK:

```sh
agentdeck add "<prompt>" --repo <repo> --title "<title>" --model <sonnet|opus> [--max-turns n] [--builds-on <tasks>] [--after <tasks>]
```

If they ask to file it for later, or for someone else to approve, add `--propose`: it lands in `proposed` and waits for `agentdeck approve <id>`.

Read `agentdeck add`'s output. AgentDeck stores the prompt with its sections as `## ` headings in the order above, and a `warning:` line means Current problem or Expected outcome is missing: add it with `agentdeck edit <id> --prompt "…"`. A path note means the prompt or the base branch is wrong: fix it the same way before the task starts. Then tell the person the task id and stop. Don't poll it: AgentDeck notifies the person when it needs them.

## On an issue-backed repo

`agentdeck repo ls` shows `issues` on a repo that takes its tasks from GitHub Issues; `agentdeck add` is refused there. The task is filed as an issue instead, and the daemon queues it from there (its title and prompt follow the issue while it waits):

- **Body:** the same four sections, as `## ` headings. The issue's title is the task's title.
- **Links:** `--blocked-by <issue>` in place of `--builds-on`: the daemon turns an open blocker into a builds-on link, and waits while the blocker has no task yet. There is no after link.
- **Model and turns:** not settable from an issue; the task takes the repo's model. Say so when you show it.
- **Part of a bigger piece:** `--parent <issue>` makes it a sub-issue; the parent's body goes into the prompt as context.

Show it as above, then on the person's OK, from the repo's path:

```sh
gh issue create --title "<title>" --body-file <file> --label ready-for-agent [--blocked-by <issues>] [--parent <issue>]
```

The `ready-for-agent` label queues it, and only a login on the repo's `issues_allow` counts (by default the one `gh` is signed in as). To file it for later, leave the label off: an unlabelled issue is the repo's proposal. Tell the person the issue's URL and stop.
