# AgentDeck

macOS daemon that works through a queue of coding tasks with `claude -p`, one git worktree per task, paced to the user's Claude quota. `daemon/` is Node + TypeScript on `node:sqlite`; `app/` is the Tauri 2 + Vue 3 dashboard.

## Commands

`pnpm test` · `pnpm typecheck` · `pnpm format` · `pnpm check` (all three) · `node daemon/scripts/crash-test.mjs 10` (SIGKILL crash test)

## Domain language

Use these words in code, logs and UI.

- **Repo:** a registered git repo with a base branch, a test command and goals.
- **Task:** one unit of work on a repo. It moves through statuses: `proposed → queued → running → done | blocked | failed | cancelled`. A cancel during a run goes through `cancel_requested`.
- **Stop reason:** why a task ended blocked or failed, in a line.
- **Link:** one task depending on another, of one of two kinds. **Builds on:** B uses A's code, so B starts once A is done and merged, and B's branch includes A's work; if A is rejected, B is stuck. **After:** B only has to land after A, so B runs any time on its own branch from the base, and only its merge waits for A's. A task's links are its **dependencies**; the tasks linked to it are its **dependents**. Not a task's **Needs**, which are what a blocked worker asked for.
- **Run:** one attempt at a task, one `claude` process. A task has at most `max_attempts` runs, and a retry continues on the same branch. A **resolve run** (`kind = 'resolve'`) is the other kind: the `claude` part of a sync, settling its conflicts. It uses no attempt.
- **Sync:** bringing the base branch into a task's branch: before every run, and for a done task when its PR conflicts or a person asks. A clean merge needs no `claude`; conflicts start a resolve run. A **conflict** is a sync that could not be settled: the merge is undone and the task is blocked. Say sync, not "bring in" or "resolve", for the whole of it.
- **Planner:** proposes tasks from a repo's goals when its queue runs dry. What it produces are **proposals** (tasks in `proposed`), never plans.
- **Governor:** decides whether new work may start, from the 5-hour and 7-day **usage windows**. A **hold** is a governor decision to wait, and only that. A repo or the daemon is **paused**, never held.
- **Slot:** room for one running task (`max_concurrent`).
- **Plan:** an HTML page attached to a task that says how it will be done, step by step (`docs/plan-format.md`). Not the planner's proposals. Write plans in `docs/plans/` in this format.

## Boundaries

`daemon/src/` is layered. Imports point down the list: an outer layer may import an inner one, never the reverse.

- **`domain/` is pure:** no I/O and no imports from other layers. It holds the entities (`Repo`, `Task`, `Run`, `PlannerRun`) and the decisions: task lifecycle, governor, prompts, tool rules, toolchain detection, planner proposals, plan parsing and PR bodies. One folder per aggregate: `task/`, `repo/`, `run/`, `planner/` (`proposals.ts`), `plan/`, `usage/`, `pull-request/`, `settings/`, `branch/` (`sync.ts`: how a sync is worded). A task's `Needs` are in `task/needs.ts` and its prompt sections (`PROMPT_SECTIONS`) in `task/task.ts`; shared text helpers such as `lastLine` are in `text.ts`.
- **SQL lives only in `db/`,** one store per table group merged into one `Db` in `db/index.ts`. The schema and migrations are in `db/schema.ts`. Every task status change is a guarded `UPDATE … WHERE status IN (…)` (`applyEvent` in `db/tasks.ts`), never a raw status write.
- **`adapters/` hold the I/O** (claude, processes, git, github, shell, notify, service, run logs, goals files). They import `domain/` and `config.ts` only, never `db/` or `application/`: they report through callbacks like `runClaude`'s `onUsage`.
- **`application/` holds the use cases,** connecting domain, db and adapters, in folders that mirror `domain/`'s aggregates: `scheduler/scheduler.ts`, `run/worker.ts`, `planner.ts`, `pull-request/pull-requests.ts`, `sync.ts` (syncing task branches with the base branch), `plans.ts`, `repo/doctor.ts`, and the person-facing use cases in `repo/repos.ts`, `task/tasks.ts` and `settings.ts`. `actions.ts` re-exports those for the CLI and the API; it is the only application module they import. Request parsing and `ActionError` are in `input.ts`.
- **Entry points:** `api/` (the dashboard's HTTP API) and `cli/` (one file per command group). They may import `domain/` and `db/`, but reach adapters only through `application/`. `src/cli.ts` stays put: the installed launchd plist runs it.
- **The CLI calls the use cases in its own process,** so it works while the daemon is down. Only work that starts `claude` (propose, a sync that may start a resolve run) goes to the daemon over HTTP (`cli/daemon-client.ts`). So the database is the only state the processes share: application code keeps no module-level state other than a lock, and a CLI change reaches the scheduler on its next tick. Each entry point parses its own input (flags, request bodies) into the use case's typed input.
- **Composition root:** `src/daemon.ts` (`runDaemon`) wires the source watcher, the API and the scheduler. It logs through a callback and throws; `cli/daemon.ts` prints and exits.
- **Dashboard types:** the API's request and response types are in `api/contract.ts`, which imports nothing. The dashboard imports them (`app/src/api/types.ts`), and `api/contract-check.ts` fails `pnpm typecheck` when a use case's type drifts from them.
- **Dashboard layout (`app/src/`):** `api/` (types, calls and wording, imported as `api`), `composables/` (`useX` functions), `lib/` (pure helpers; rules come from the daemon's `domain/`, never copied), `platform/` (the Tauri shell, build commit, theme), `styles/`, and `components/` by area: `ui/` (shared pieces), `layout/` (the app's frame), `panels/`, `queue/`, `task/`, `files/`.

## Rules

`daemon/test/architecture.test.ts` checks the Boundaries above, plus the dependency, migration and process-group rules below. Each failure names the file, line and rule.

- **Erasable TypeScript only.** Node runs `.ts` directly, so no enums, namespaces or constructor parameter properties.
- **No new runtime dependencies** without a reason. The one there is, `drizzle-orm`, is pinned at exactly `1.0.0-rc.5` (no caret) and the stores are moving onto it (`docs/plans/drizzle.html`); use only its core query builder, not the relational query API. `pnpm db:studio` browses the live database, `pnpm db:check` checks `db/tables.ts` against the migrations.
- **Schema changes are appended as new migration steps.** Never edit a step that has shipped. Mirror the change in `db/tables.ts` and in the domain type: `pnpm typecheck` (`db/types-check.ts`) and `pnpm db:check` fail until all three agree. Once a step is final, append the hash the test prints to `daemon/test/migrations.lock`.
- **Every `claude` runs in its own process group** with its pid recorded on the run, so crash recovery can stop it.
- **Keep this checkout on `main`.** The installed daemon runs its `daemon/src/cli.ts`, so switching branches here swaps the live daemon's code. Try task branches from their worktrees.
- **Delegating to AgentDeck:** when to queue a task instead of doing it here, how to write it, and how to work in a task's worktree are in the `delegate` skill (`.claude/skills/delegate/SKILL.md`).
