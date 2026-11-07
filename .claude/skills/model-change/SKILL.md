---
name: model-change
description: Change AgentDeck's domain model end to end: a new or changed field on a task, repo, run or another aggregate, through its type, store mapper, migration, API contract and generated docs. Use when adding a column, a status, a value object or a field the dashboard shows.
---

# Change the domain model

Follow the steps in order; `pnpm typecheck` and `pnpm db:check` fail until the pieces agree.

1. **Type.** Add the field to the aggregate's type in `daemon/src/domain/<aggregate>/`, and the decision that uses it as a pure function there. Say it in the words of `GLOSSARY.md`.
2. **Table.** Add the column to its table in `daemon/src/db/tables.ts`. Tasks, repos and runs are read through `daemon/src/db/mappers.ts`: where the field differs from its column, change the mapper too. `daemon/src/db/types-check.ts` fails typecheck when a mapper leaves a column unaccounted for, and when another table's row and its domain type differ.
3. **Migration.** Run `pnpm db:generate`, which prints the SQL, and append it as a new step in `daemon/src/db/schema.ts`. Never edit a shipped step, and only add: a rename or drop breaks a daemon still running older code, so add a column and stop reading the old one. Run `pnpm db:check`.
4. **Store.** Use the column in the store's queries. A status change stays a guarded `UPDATE … WHERE status IN (…)` through `applyEvent`.
5. **Contract.** If the dashboard needs it, add it to `daemon/src/api/contract.ts` (flat, imports only types from `domain/`). `daemon/src/api/contract-check.ts` checks request types against the use cases. Dashboard code imports them through `app/src/api/types.ts`.
6. **Generated docs.** Run `pnpm docs:gen` (the edit hook does it after edits under `daemon/src`) so `docs/architecture.md` is not stale.
7. **Lock.** Once the migration is final, append the hash `daemon/test/migrations.lock`'s test prints.
8. **Check.** Run `pnpm check:fast`. Add a test of the new decision in `daemon/test/`.
