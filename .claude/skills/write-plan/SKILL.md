---
name: write-plan
description: Write an AgentDeck plan (an HTML page AgentDeck stores with a task, saying how work will be done, step by step) and split it into linked tasks. Use when the user says write a plan, plan this out, break this into tasks, or when work is too big for one task. For a single task, use add-task.
---

# Write a plan and split it into tasks

A **plan** is an HTML page attached to tasks that says how the work will be done, step by step. The daemon puts each linked step's text and done criteria into the worker's prompt, and the dashboard shows the steps on the task's Overview. Not the planner's proposals: those are tasks. Whether to delegate at all, and the sandbox limits, are in the `delegate` skill. On a repo that takes its tasks from GitHub Issues (`issues` in `agentdeck repo ls`), the plan is a parent issue: see the last section.

## 1. Settle it with the person

Read the code first, then agree on the approach in this session: what changes, in what order, and what is out of scope. A plan written before the decisions are made sends workers off in the wrong direction.

## 2. Write the page

Write it as a draft outside the repo, at `~/.agentdeck/drafts/<short-name>.html`, in the plan format: `docs/plan-format.md` in the AgentDeck repo is the reference, `docs/plans/sync-in-dashboard.html` an example. Plans live in AgentDeck, never in the repo: the draft is only the file you hand to `agentdeck add`, and once it is attached AgentDeck's copy is the plan.

- `<html lang="en" data-agentdeck-plan="1">`, a `<title>`, and `<link rel="stylesheet" href="plan.css" />` in the head. No `<style>` block, no scripts.
- One `<p data-plan-summary>`: what the plan does and why, in a paragraph.
- Free HTML before the steps for the why: what is wrong today, with file paths.
- One `<section data-plan-step id="…" data-status="todo">` per step, each with an `<h2>` title, the change, and one `<ul data-plan-done>` of checks.
- An Out of scope list after the steps.

**Sizing steps:** a step is what one worker can do and test in one run: one layer or one screen, a few files. Split where a reviewer would want to look, or where later work depends on it landing. Three to six steps is usual; one step means it should be a plain task (`add-task`).

**Done criteria:** each one a check a reviewer can confirm without asking: a named test, a command's output, something seen in the dashboard. "Works well" is not a check. Name full paths from the repo root.

Check the page parses before going on:

```sh
node -e 'import("./daemon/src/domain/work/plans/plan.ts").then(m => console.log(JSON.stringify(m.parsePlan(require("fs").readFileSync(process.argv[1], "utf8")), null, 1)))' ~/.agentdeck/drafts/<short-name>.html
```

(from the AgentDeck checkout; it prints the title, summary and steps, or null when the marker is missing). Nothing is committed: no plan goes to the base branch.

## 3. One task per group of steps

Queue a task for each group of steps that should land as one PR. The first task takes the draft, which AgentDeck stores as that task's plan, named after it (`<task id>-<slug>.html`):

```sh
agentdeck add "<prompt>" --repo <repo> --title "<title>" --plan ~/.agentdeck/drafts/<short-name>.html --steps a,b --model <sonnet|opus> [--max-turns n]
```

The rest follow that plan by the first task's number:

```sh
agentdeck add "<prompt>" --repo <repo> --title "<title>" --plan <first task> --steps c [--builds-on <task>] [--after <task>] --model <sonnet|opus> [--max-turns n]
```

- **Prompt:** the sections of `add-task`, as `## ` headings: `## Current problem` (what is wrong or missing today, and where), `## Expected outcome` (bullets a reviewer can check, the last one the repo's test command passing; for a task on a plan, a bullet naming its steps, whose done criteria are the rest), then `## Out of scope` and `## Constraints` where they have something to say. The linked steps supply the how. Write paths in full from the repo root, or `agentdeck add` warns about them; it also warns when Current problem or Expected outcome is missing.
- **`--steps`:** the step ids for this task. Without it, every step not yet done or skipped.
- **Model:** choose one per task, from its steps. The rule: `opus` for subtle design, a wide change or a step a reviewer would struggle to check (a migration, a state machine, concurrency); `sonnet` for a well-specified change of a few files; `haiku` only for mechanical work. Show the choice with the task. Without `--model` the task takes the repo's model, else the `default_model` setting.
- **Links between the tasks:** `--builds-on` when a task needs the code of an earlier one: it starts once that one is merged, on a branch that has it. `--after` when it only has to land after it: it runs at once and only its merge waits. Prefer `--after` where the code doesn't overlap, so the tasks run side by side.
- **Turns:** a task carrying several steps needs more than the default 40: 80 for two or three, 120 for a large port.

Show the person the tasks, their models and their links, then ask "Would you like to do this on a branch now, or add to tasks?" (the `delegate` skill says what to give with it). Queue only on "tasks"; on "a branch", work through the steps here on one branch, a commit per step, and the plan is the checklist. The plan shows on each task's Overview at once. Workers set their steps' `data-status` as they go, and AgentDeck saves back only each task's own steps, so tasks on one plan can run side by side. To change the plan before its tasks run, edit the draft and `agentdeck attach <first task> ~/.agentdeck/drafts/<short-name>.html`.

Tell the person the task ids and stop.

## On an issue-backed repo

`agentdeck add` is refused on a repo with `issues` in `agentdeck repo ls`, so the plan and its tasks are issues. Settle the approach first, as in step 1; then, instead of steps 2 and 3:

- **The plan is a parent issue,** in Markdown, not the HTML page: the summary, the why with file paths, then one `### <step title>` per step with its change and a list of its done checks, then Out of scope. Its body goes into every sub-issue's prompt as context, so write it for the worker. No `ready-for-agent` label on it: it is not work itself.
- **Each group of steps is a sub-issue,** in the four sections of `add-task`, created with `--parent <parent issue>`. The steps don't reach the worker on their own here, so its Expected outcome carries its steps' done checks, not only their names.
- **Links:** `--blocked-by <issue>` where `--builds-on` would go; there is no after link. Create the issues in order, so a blocker exists before the issue it blocks.
- **Model and turns** can't be set from an issue; every task takes the repo's model.

Show the person the parent and the sub-issues and ask "Would you like to do this on a branch now, or add to tasks?"; on "tasks", from the repo's path:

```sh
gh issue create --title "<plan title>" --body-file <plan.md>
gh issue create --title "<task title>" --body-file <task.md> --parent <plan issue> [--blocked-by <issues>] --label ready-for-agent
```

Each labelled sub-issue is queued on the daemon's next poll (every two minutes); leave the label off any that should wait. Every task targets the repo's base branch: an issue can't open a plan branch yet. Tell the person the issue URLs and stop.
