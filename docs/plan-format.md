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

Everything else is free HTML: tables, code, notes, inline `<style>`. Scripts don't run when the dashboard shows the page, and comments, `<script>`, `<style>` and `<template>` are ignored when reading the marked parts. Give each step an `id` so the dashboard can jump to it. A plan can be at most 512 KB.

## Template

```html
<!doctype html>
<html lang="en" data-agentdeck-plan="1">
  <head>
    <meta charset="utf-8" />
    <title>Cache repo reads</title>
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

## How a plan reaches a task

- **From the task's branch.** After every run, the daemon reads the HTML files the branch added or changed under `docs/plans/` and attaches those that carry the marker. A plan deleted from the branch is detached. Workers are told the format in their system prompt (`domain/run/prompt.ts`).
- **Attached by hand.** `agentdeck attach <task> plan.html` attaches a plan written anywhere, under its file name; attaching the same name again replaces it. A file under `docs/plans/` is named by its path from there on (`docs/plans/x.html`), the name the branch's copy gets, so once the branch has the file, its copy replaces the attached one. `agentdeck attach <task>` with no file re-reads the branch.
- **Through the API.** `POST /api/tasks/:id/plans` with `{ "name": "plan.html", "html": "…" }`. `POST /api/tasks/:id/plans/collect` re-reads the branch.

The task detail (`GET /api/tasks/:id`) lists the parsed plans under `plans`, without their HTML; `GET /api/tasks/:id/plans/:plan` returns `{ html }`. The parser is `parsePlan` in `daemon/src/domain/plan/plan.ts`.
