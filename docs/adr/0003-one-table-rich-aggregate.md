# ADR 0003: One table mapped to a rich aggregate, with a flat API

Status: accepted, 2026-11-07

An aggregate such as a task stays in one table (`tasks`), with no table per concept, and the store maps its row to a richer domain type and back. The API and the dashboard keep the flat shape of the row (`api/contract.ts`), so a change to the model's insides doesn't ripple into the dashboard. One table means a status change is a single guarded `UPDATE … WHERE status IN (…)` (`applyEvent` in `daemon/src/db/tasks.ts`) with no transaction across tables, and the CLI and the daemon, which are separate processes, stay consistent through that one statement. `daemon/src/db/types-check.ts` fails `pnpm typecheck` when a table and its domain type drift apart. The cost is a wide table and a mapper to keep in step with it.

## Consequences

- A new field is a column, a domain type change and a mapper change, in that order (the `model-change` skill walks through it).
- The contract types are flat on purpose: don't expose the aggregate's nested value objects to the dashboard.
