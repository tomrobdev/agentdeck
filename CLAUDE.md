# AgentDeck

macOS daemon that works through a queue of coding tasks with `claude -p`, one git worktree per task, paced to the user's Claude quota. `daemon/` is Node + TypeScript on `node:sqlite`; `app/` is the Tauri 2 + Vue 3 dashboard.

## Commands

`pnpm test` · `pnpm typecheck` · `pnpm format` · `pnpm check` (all three) · `node daemon/scripts/crash-test.mjs 10` (SIGKILL crash test)

## Domain language

Use these words in code, logs and UI.

- **Repo:** a registered git repo with a base branch, a test command and goals.
- **Task:** one unit of work on a repo. It moves through statuses: `proposed → queued → running → done | blocked | failed | cancelled`. A cancel during a run goes through `cancel_requested`.
- **Run:** one attempt at a task, one `claude` process. A task has at most `max_attempts` runs, and a retry continues on the same branch.
- **Planner:** proposes tasks from a repo's goals when its queue runs dry.
- **Governor:** decides whether new work may start, from the 5-hour and 7-day **usage windows**. A **hold** is a governor decision to wait.
- **Slot:** room for one running task (`max_concurrent`).

## Boundaries

- **Domain logic is pure:** no I/O. This covers task lifecycle transitions, governor decisions and prompt building. It lives in `daemon/src/domain/` and `governor.ts`.
- **SQL lives only in `db.ts`.** Every task status change is a guarded `UPDATE … WHERE status IN (…)`, never a raw status write.
- **Adapters hold the I/O:** `claude.ts`, `git.ts`, `notify.ts`, `service.ts`.
- **Wiring:** `scheduler.ts`, `worker.ts`, `actions.ts`, `api.ts` and `cli.ts` connect domain and adapters.
- **Dashboard types:** the dashboard mirrors daemon types in `app/src/api.ts`, so keep them in sync.

## Rules

- **Erasable TypeScript only.** Node runs `.ts` directly, so no enums, namespaces or constructor parameter properties.
- **No new runtime dependencies** without a reason. Drizzle is deferred until 1.0 is stable.
- **Schema changes are appended as new migration steps.** Never edit a step that has shipped.
- **Every `claude` runs in its own process group** with its pid recorded on the run, so crash recovery can stop it.
