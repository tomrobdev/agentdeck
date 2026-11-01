# Plan format

A plan is one HTML page that says how a task will be done, step by step. People read it as a page; AgentDeck reads a few marked parts of it and shows them on the task's Overview: the title, a summary, and each step with its status.

## The marked parts

| Part          | Markup                                                                     | Rules                                                                                                                  |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Marker        | `<html data-agentdeck-plan="1">`                                           | Required. HTML without it is not a plan. The value is the format version.                                              |
| Title         | `<title>…</title>`                                                         | Falls back to the first `<h1>`, then "Untitled plan".                                                                  |
| Summary       | `<p data-plan-summary>…</p>`                                               | Optional. One paragraph: what the plan does and why.                                                                   |
| Step          | `<section data-plan-step id="…" data-status="…">`                          | One per step, in order. Don't nest sections inside a step.                                                             |
| Step title    | the first `<h1>`–`<h6>` in the section                                     | All its text is the title, so keep badges out of it. Falls back to the value of `data-plan-step`, then "Step n".       |
| Status        | `data-status` on the step: `todo`, `doing`, `done`, `blocked` or `skipped` | Anything else reads as `todo`. Keep it current as the work moves.                                                      |
| Done criteria | `<ul data-plan-done>` inside a step                                        | Optional. One `<li>` per check; without `<li>`s the element's whole text is one check. The first one in a step counts. |

Everything else is free HTML: tables, code, notes. Scripts don't run when the dashboard shows the page, and comments, `<script>`, `<style>` and `<template>` are ignored when reading the marked parts. Give each step an `id` so the dashboard can jump to it. A plan can be at most 512 KB.

## Template

```html
<!doctype html>
<html lang="en" data-agentdeck-plan="1">
  <head>
    <meta charset="utf-8" />
    <title>Cache repo reads</title>
    <link rel="stylesheet" href="plan.css" />
  </head>
  <body>
    <h1>Cache repo reads</h1>
    <p data-plan-summary>The task page reads the same files from git on every poll. Cache them per commit.</p>

    <section data-plan-step id="measure" data-status="done">
      <h2>Measure</h2>
      <p>…</p>
      <ul data-plan-done>
        <li>The slow reads are listed with timings.</li>
      </ul>
    </section>
    <section data-plan-step id="cache" data-status="doing">
      <h2>Add the cache</h2>
      <p>…</p>
    </section>
  </body>
</html>
```

## Styling

A plan carries no CSS. It links the shared stylesheet from the head (`<link rel="stylesheet" href="plan.css" />`) and has no `<style>` block, so plans stay small to write and to read into a worker's context. The stylesheet, `docs/plans/plan.css` in AgentDeck's own repo, covers the page, headings, tables, code, `section` steps, and the classes `.wrap` with `nav.toc` (a contents list beside the page), `.lede`, `.card`, `.decision`, `.meta`, `.tag` (with `ok`, `warn` or `info`), `.grid2`, `.muted` and `ul.check`. A rule only one plan needs can go in that plan's own `<style>`.

The dashboard shows a plan in a frame where a relative link doesn't resolve, so `PlanCard.vue` swaps that link for the stylesheet's contents, bundled at build time.

## Where plans live

Plans live in AgentDeck's database, not in the repo: a plan is never committed, so plans work the same in any repo and stay out of its history. A plan belongs to the task it was first attached to and is named after it: `<task id>-<slug>.html`, the slug from the plan's title (`112-plans-in-agentdeck.html`). The CLI, the dashboard and the PR body show that name. The pages already in AgentDeck's own `docs/plans/` were written before this; they stay where they are.

- **With a new task.** `agentdeck add "…" --plan /any/path/x.html [--steps a,b]` reads the file, checks it is a plan, stores it as the new task's plan and links the task to it. `agentdeck edit <task> --plan <file>` does the same for an existing task, replacing its plan.
- **Following another task's plan.** `--plan <task number>` (`--plan 112`) links the task to that task's plan, which must be in the same repo; `--steps` names the steps it carries out, checked against the stored plan. The dashboard's New task form and the API (`plan_task`) take the task number. Several tasks can follow one plan, each doing its own steps.
- **Attached by hand.** `agentdeck attach <task> plan.html` stores or replaces the task's own plan under its numbered name. Through the API: `POST /api/tasks/:id/plans` with `{ "html": "…" }`.
- **Written by a worker.** A task with no plan that writes one (because it was asked to, or the work is big enough to need one) writes it to the plan file below, and the daemon stores it as the task's plan after the run.

The task detail (`GET /api/tasks/:id`) lists the parsed plans under `plans`, without their HTML: the plan the task follows when it belongs to another task, then the task's own. `GET /api/tasks/:id/plans/:plan` returns `{ html }`, with `:id` the task the plan belongs to (its `task_id`). Plans stored before plans moved into AgentDeck keep their old names and still show. The parser is `parsePlan` in `daemon/src/domain/plan/plan.ts`.

## How a run uses its plan

A task follows its linked plan, or else its own plan. Before every run the daemon writes that plan to `.agentdeck/plan.html` in the task's worktree; a `.gitignore` in `.agentdeck/` makes git ignore the folder, so the file is never committed. The worker's prompt lists the linked steps that are not yet done and tells it to set each one's `data-status` in that file and never to commit it.

After every run, whatever its outcome, the daemon reads the file back and saves only the task's linked steps into the stored plan: each step's whole section, with its status and any note the worker put in it (`mergePlanSteps`). The rest stays as stored, because sibling tasks on one plan may run at the same time and each writes back its own steps. A task that follows its own plan with no other task on it keeps the whole file. The PR body and the check for linked steps a done run left unfinished read the stored plan.
