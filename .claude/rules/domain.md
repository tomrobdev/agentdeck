---
paths:
  - 'daemon/src/domain/**'
---

# Working in `domain/`

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **`domain/` is pure: no I/O and no imports from other layers.** (`rule:domain-pure`)
  - It holds the entities (`Repo`, `Task`, `Run`, `PlannerRun`) and the decisions: task lifecycle, governor, prompts, tool rules, toolchain detection, planner proposals, plan parsing and PR bodies.
  - One folder per bounded context (see Contexts in `GLOSSARY.md`):
    - `work/`: tasks, links, stages, branch names, `plan.ts`; `work/read/` for listings and a task's changed files.
    - `runs/`: runs, prompts, unblock runs, `sync.ts` (how a sync is worded) and `resolve.ts` (how a resolve run's end settles it); `runs/translate/` for the run log, live state and sandbox settings.
    - `landing/`: pull requests, checks, merging, and reviews with their line comments and how a comment's state moves.
    - `repos/`: repos with their PR mode and merge method, tool rules, toolchain detection, protected edits.
    - `capacity/`: the usage windows and the governor.
    - `proposals/`: the planner's proposals.
    - `operations/`: the daemon's health, headline and restart, notification kinds, settings and `digest.ts` (the live state of a repo's queue for an agent).
    - `insights/`: the scorecard and what is counted over time.
    - `shared/`: `text.ts`, `time.ts`, `id.ts`.
  - The contexts import each other one way: proposals, runs → work → landing → repos, with capacity below and insights and operations above, reading the others.
  - A task's `Needs` are in `work/task/needs.ts`, and its prompt sections (`PROMPT_SECTIONS`) and the one parser that reads them in either style (`parsePrompt`, `promptSection`, `shapePrompt`) in `work/task/prompt.ts`; shared text helpers such as `lastLine` are in `shared/text.ts`.
- **A deterministic domain.** `domain/` reads no clock (`Date.now()`, `new Date()` without arguments), no randomness (`Math.random()`, `crypto`) and no `process`: the time and random values are arguments. Checked with the strict types, on the same list. (`rule:domain-deterministic`)
- **Every domain function has a pure test.** (`rule:domain-tests`)
  - Each function a context's `index.ts` under `daemon/src/domain/` exports is used in at least one pure test: a test file that imports nothing from `daemon/src/db`, `application` or `adapters`, `daemon/test/fixtures/`, `node:fs` or `node:child_process`.
  - The exports with none are on `UNTESTED_DOMAIN_EXPORTS`, a list that only shrinks: a new one fails, naming the function and its file, and so does an entry that now has a test.
- **Contexts are imported through their `index.ts`.** (`rule:contexts`)
  - Each folder under `domain/` has an `index.ts` of named exports, no `export *`.
  - Another context, the layers above and the dashboard import a context only through it, so nothing outside a context reaches into its files or into `read/` or `translate/`.
  - An export nothing outside the context imports is removed.
- **A state machine is a rule table in `domain/`** (`RULES` in `work/lifecycle/lifecycle.ts`, `COMMENT_MOVES` in `landing/review/review.ts`), and `pnpm docs:gen` lists it in `docs/reference/state-machines.md`. A state type no table drives is on the allow-list in `daemon/scripts/lib/model-docs.ts` with its reason; pull request state and merge requests are there until they are tables. (`rule:state-as-data`)
- **A task write with a rule is a domain function.** (`rule:task-writes`)
  - A write to `tasks` other than a status change (PR state and checks, merge requests, auto-merge, a question) takes its changes from a pure function in `domain/work/lifecycle/task-writes.ts`; the task store in `db/work/` only persists them under its guard.
  - A plain write (the checkout, an edit, a lock) stays in the store and is on `PLAIN_TASK_WRITES` with its reason, a list that `docs/reference/progress.md` counts: a new `.update(tasks)` that is neither fails.
- **Ids are branded.** (`rule:branded-ids`)
  - `TaskId`, `RepoId`, `RunId`, `ReviewId` and `PlannerRunId` (`domain/shared/id.ts`) are numbers the compiler keeps apart, erased at runtime.
  - An entry point parses an id once (`parseId`, `parseTaskIds`); stores return branded ids (the table columns say so in `db/tables.ts`), and use cases take them.
  - A domain or contract field named `…_id` or `…Id` is never typed `number`. A test makes an id with `asTaskId` and the like.

## How to

- Model a thing as a type and the decisions about it as functions from values to values. No classes, no enums.
- One folder per aggregate. Put a new decision beside the type it decides about, not in `db/` or `application/`.
- Take the clock, random ids and anything else impure as arguments (`time.ts` has the shared helpers).
- Use the words in CLAUDE.md's Domain language in names and in user-facing text built here.
- A test calls the function with plain values; no database, no fakes. Name the rule it checks. Every function a context's `index.ts` exports needs one such pure test (`rule:domain-tests`): a test file that imports nothing from `db/`, `application/`, `adapters/`, `test/fixtures/`, `node:fs` or `node:child_process`. A test that needs one of those does not count, so keep the pure cases in a file of their own.
- Changing a type used by a table or by `api/contract/`: follow the `model-change` skill.
- Write no code comment but the file's leading one-line comment and the comments on a type and its fields, which the model docs print (`rule:code-comments`): put any other reason in a name, a type or a test.
