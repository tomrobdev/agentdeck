---
name: write-plan
description: Write an AgentDeck plan (an HTML page in docs/plans/ that says how work will be done, step by step) and split it into linked tasks. Use when the user says write a plan, plan this out, break this into tasks, or when work is too big for one task. For a single task, use add-task.
---

# Write a plan and split it into tasks

A **plan** is an HTML page attached to tasks that says how the work will be done, step by step. The daemon puts each linked step's text and done criteria into the worker's prompt, and the dashboard shows the steps on the task's Overview. Not the planner's proposals: those are tasks. Whether to delegate at all, and the sandbox limits, are in the `delegate` skill.

## 1. Settle it with the person

Read the code first, then agree on the approach in this session: what changes, in what order, and what is out of scope. A plan written before the decisions are made sends workers off in the wrong direction.

## 2. Write the page

Write it to `docs/plans/<short-name>.html` in the plan format: `docs/plan-format.md` in the AgentDeck repo is the reference, `docs/plans/sync-in-dashboard.html` an example.

- `<html lang="en" data-agentdeck-plan="1">`, a `<title>`, and `<link rel="stylesheet" href="plan.css" />` in the head. No `<style>` block, no scripts.
- One `<p data-plan-summary>`: what the plan does and why, in a paragraph.
- Free HTML before the steps for the why: what is wrong today, with file paths.
- One `<section data-plan-step id="…" data-status="todo">` per step, each with an `<h2>` title, the change, and one `<ul data-plan-done>` of checks.
- An Out of scope list after the steps.

**Sizing steps:** a step is what one worker can do and test in one run: one layer or one screen, a few files. Split where a reviewer would want to look, or where later work depends on it landing. Three to six steps is usual; one step means it should be a plain task (`add-task`).

**Done criteria:** each one a check a reviewer can confirm without asking: a named test, a command's output, something seen in the dashboard. "Works well" is not a check. Name full paths from the repo root.

Check the page parses before going on:

```sh
node -e 'import("./daemon/src/domain/plan/plan.ts").then(m => console.log(JSON.stringify(m.parsePlan(require("fs").readFileSync(process.argv[1], "utf8")), null, 1)))' docs/plans/<short-name>.html
```

(from the AgentDeck checkout; it prints the title, summary and steps, or null when the marker is missing).

## 3. Commit it to the base branch and push

Commit the plan as its own commit on the base branch, then **push it**. Task branches start from `origin/<base>`, so a plan that is only committed locally is not on the task's branch, and the worker can't read it. In the AgentDeck repo, keep the checkout on `main`.

## 4. One task per group of steps

Queue a task for each group of steps that should land as one PR, linked to the plan:

```sh
agentdeck add "<prompt>" --repo <repo> --title "<title>" --plan docs/plans/<short-name>.html --steps a,b [--builds-on <task>] [--after <task>] [--model sonnet] [--max-turns n]
```

- **Prompt:** only Goal, Out of scope and Constraints. The linked steps supply Change and Definition of done. Write paths in full from the repo root, or `agentdeck add` warns about them.
- **`--steps`:** the step ids for this task. Without it, every step not yet done or skipped.
- **Links between the tasks:** `--builds-on` when a task needs the code of an earlier one: it starts once that one is merged, on a branch that has it. `--after` when it only has to land after it: it runs at once and only its merge waits. Prefer `--after` where the code doesn't overlap, so the tasks run side by side.
- **Turns:** a task carrying several steps needs more than the default 40: 80 for two or three, 120 for a large port.

Show the person the tasks and their links before queueing, and queue on their OK. To show the plan on a task's Overview before its first run, `agentdeck attach <id> docs/plans/<short-name>.html`. Workers set each step's `data-status` as they go; the branch's copy replaces the attached one.

Tell the person the task ids and stop.
