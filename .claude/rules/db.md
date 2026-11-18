---
paths:
  - 'daemon/src/db/**'
  - 'daemon/test/db/**'
---

# Working in `db/`

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **Queries live only in `db/`, through Drizzle** (raw `sql` only where the builder hides a guard). (`rule:sql-in-db`)
  - One store per table group, in a folder per context (`db/work/`, `db/runs/` and the rest), merged into one `Db` in `db/index.ts`.
  - The tables are in `db/tables.ts`, the migrations in `db/schema.ts`.
- **Every task status change is a guarded `UPDATE … WHERE status IN (…)`** (`applyEvent` in `db/work/tasks-status.ts`, the claim included), never a raw status write. (`rule:guarded-status`)
- **Schema changes are appended as new migration steps.** Never edit a step that has shipped. (`rule:migrations-append`)
  - To add a column:
    1. Add it to its table in `db/tables.ts` and to the domain type.
    2. Run `pnpm db:generate`, which prints the SQL that makes a migrated database match `tables.ts`.
    3. Append that SQL as a new step in `db/schema.ts`.
    4. Run `pnpm db:check` and `pnpm typecheck` (`db/types-check.ts`), which fail until `tables.ts`, the migrations and the domain type agree.
    5. Use the column in the store's queries.
    6. Once the step is final, append the hash the test prints to `daemon/test/db/migrations.lock`.
  - A new step only adds, never renames or drops: the CLI migrates as soon as it runs on pulled code, while a daemon on older code may still be running.
- **Models, not rows.** (`rule:models-not-rows`)
  - A store reads a whole row of `tasks`, `repos` or `runs` only through `db/mappers.ts` (`toTask`, `toRepo`, `toRun`), so a domain type need not equal its row: `db/types-check.ts` fails when a mapper leaves a column unaccounted for.
  - The flags and JSON documents left on domain entities are on `ROW_SHAPED_FIELDS`, a list that only shrinks.
- **A task write with a rule is a domain function.** (`rule:task-writes`)
  - A write to `tasks` other than a status change (PR state and checks, merge requests, auto-merge, a question) takes its changes from a pure function in `domain/work/lifecycle/task-writes.ts`; the task store in `db/work/` only persists them under its guard.
  - A plain write (the checkout, an edit, a lock) stays in the store and is on `PLAIN_TASK_WRITES` with its reason, a list that `docs/reference/progress.md` counts: a new `.update(tasks)` that is neither fails.

## How to

- Queries use Drizzle's core builder; reach for raw `sql` only where the builder hides a guard.
- A task's status changes through `applyEvent`, the claim included, as a guarded `UPDATE … WHERE status IN (…)`. Check the affected row count and return the outcome, never assume it.
- A store is one file per table group, merged into `Db` in `index.ts`. It returns domain types and takes no decisions of its own.
- A whole row of `tasks`, `repos` or `runs` goes through `mappers.ts`: `.all().map(toTask)`, or `mapFound(….get(), toTask)` for a row that may not exist. A selection that lists its columns is a projection and needs no mapper.
- Never edit a shipped step in `schema.ts`: append a new one. `pnpm db:generate` prints the SQL; `pnpm db:check` and `pnpm typecheck` (`types-check.ts`) say when `tables.ts`, the migrations, the mappers and the domain types disagree.
- Once a step is final, append its hash to `daemon/test/db/migrations.lock`.
- Tests use a scratch database (`daemon/scripts/scratch-db.ts`), never `~/.agentdeck`.
- A new step in `schema.ts` gets a one-line heading comment (`// 12: what it does.`), which the docs print; no other code comment (`rule:code-comments`).
