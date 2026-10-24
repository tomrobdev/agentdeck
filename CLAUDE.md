# AgentDeck

macOS daemon that works through a queue of coding tasks with `claude -p`, one git worktree per task, paced to the user's Claude quota. `daemon/` is Node + TypeScript on `node:sqlite`; `app/` is the Tauri 2 + Vue 3 dashboard.

## Commands

`pnpm test` · `pnpm typecheck` · `pnpm format` · `pnpm check` (all three) · `node daemon/scripts/crash-test.mjs 10` (SIGKILL crash test)

## Domain language

Use these words in code, logs and UI.

- **Repo:** a registered git repo with a base branch, a test command and goals.
- **Task:** one unit of work on a repo. It moves through statuses: `proposed → queued → running → done | blocked | failed | cancelled`. A cancel during a run goes through `cancel_requested`.
- **Run:** one attempt at a task, one `claude` process. A task has at most `max_attempts` runs, and a retry continues on the same branch. A **resolve run** (`kind = 'resolve'`) is the other kind: it merges the base branch into the task's branch to settle conflicts, and uses no attempt.
- **Planner:** proposes tasks from a repo's goals when its queue runs dry.
- **Governor:** decides whether new work may start, from the 5-hour and 7-day **usage windows**. A **hold** is a governor decision to wait.
- **Slot:** room for one running task (`max_concurrent`).
- **Plan:** an HTML page attached to a task that says how it will be done, step by step (`docs/plan-format.md`). Not the planner's proposals. Write plans in `docs/plans/` in this format.

## Boundaries

`daemon/src/` is layered. Imports point down the list: an outer layer may import an inner one, never the reverse.

- **`domain/` is pure:** no I/O and no imports from other layers. It holds the entities (`Repo`, `Task`, `Run`, `PlannerRun`) and the decisions: task lifecycle, governor, prompts, tool rules, toolchain detection, planner proposals, plan parsing and PR bodies. One folder per aggregate: `task/`, `repo/`, `run/`, `planner/`, `plan/`, `usage/`, `pull-request/`.
- **SQL lives only in `db/`,** one store per table group merged into one `Db` in `db/index.ts`. The schema and migrations are in `db/schema.ts`. Every task status change is a guarded `UPDATE … WHERE status IN (…)` (`applyEvent` in `db/tasks.ts`), never a raw status write.
- **`adapters/` hold the I/O** (claude, processes, git, github, shell, notify, service, run logs, goals files). They import `domain/` and `config.ts` only, never `db/` or `application/`: they report through callbacks like `runClaude`'s `onUsage`.
- **`application/` holds the use cases,** connecting domain, db and adapters: `scheduler.ts`, `worker.ts`, `planner.ts`, `pull-requests.ts`, `conflicts.ts` (bringing the base branch into task branches), `plans.ts`, `doctor.ts`, and the person-facing use cases in `repos.ts`, `tasks.ts` and `settings.ts`. `actions.ts` re-exports those for the CLI and the API.
- **Entry points:** `api/` (the dashboard's HTTP API) and `cli/` (one file per command group). `src/cli.ts` stays put: the installed launchd plist runs it.
- **Dashboard types:** the dashboard mirrors daemon types in `app/src/api.ts`, so keep them in sync.

## Rules

- **Erasable TypeScript only.** Node runs `.ts` directly, so no enums, namespaces or constructor parameter properties.
- **No new runtime dependencies** without a reason. Drizzle is deferred until 1.0 is stable.
- **Schema changes are appended as new migration steps.** Never edit a step that has shipped.
- **Every `claude` runs in its own process group** with its pid recorded on the run, so crash recovery can stop it.
- **Keep this checkout on `main`.** The installed daemon runs its `daemon/src/cli.ts`, so switching branches here swaps the live daemon's code. Try task branches from their worktrees.
- **Delegating to AgentDeck:** when to queue a task instead of doing it here, how to write it, and how to work in a task's worktree are in the `delegate` skill (`.claude/skills/delegate/SKILL.md`).
