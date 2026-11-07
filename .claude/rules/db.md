# Working in `db/`

How-to only. The rule statements (queries only here, guarded status updates, append-only migrations, models not rows) are in CLAUDE.md.

- Queries use Drizzle's core builder; reach for raw `sql` only where the builder hides a guard.
- A task's status changes through `applyEvent` (or `claimNextTask`), as a guarded `UPDATE … WHERE status IN (…)`. Check the affected row count and return the outcome, never assume it.
- A store is one file per table group, merged into `Db` in `index.ts`. It returns domain types and takes no decisions of its own.
- A whole row of `tasks`, `repos` or `runs` goes through `mappers.ts`: `.all().map(toTask)`, or `mapFound(….get(), toTask)` for a row that may not exist. A selection that lists its columns is a projection and needs no mapper.
- Never edit a shipped step in `schema.ts`: append a new one. `pnpm db:generate` prints the SQL; `pnpm db:check` and `pnpm typecheck` (`types-check.ts`) say when `tables.ts`, the migrations, the mappers and the domain types disagree.
- Once a step is final, append its hash to `daemon/test/migrations.lock`.
- Tests use a scratch database (`daemon/scripts/scratch-db.ts`), never `~/.agentdeck`.
