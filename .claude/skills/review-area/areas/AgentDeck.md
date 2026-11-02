# AgentDeck areas

One heading per area, then the path prefixes it covers (a folder ends in `/`). Areas are slices down through the layers, one per aggregate; the layers themselves are checked by `daemon/test/architecture.test.ts`. A file may sit in two areas. A change outside every area is named in the report as unmapped.

## plan

- daemon/src/domain/plan/
- daemon/src/application/plans.ts
- daemon/src/adapters/plan-file.ts
- daemon/src/db/plans.ts
- daemon/src/api/routes/plans.ts
- app/src/components/task/PlanCard.vue
- docs/plan-format.md

## task

- daemon/src/domain/task/
- daemon/src/application/task/
- daemon/src/db/tasks.ts
- daemon/src/api/routes/tasks.ts
- daemon/src/cli/tasks.ts

## run

- daemon/src/domain/run/
- daemon/src/application/run/
- daemon/src/adapters/claude.ts
- daemon/src/adapters/processes.ts
- daemon/src/adapters/run-log.ts
- daemon/src/db/runs.ts

## scheduler

- daemon/src/application/scheduler/
- daemon/src/domain/usage/
- daemon/src/db/usage.ts
- daemon/src/daemon.ts

## sync

- daemon/src/application/sync.ts
- daemon/src/domain/branch/
- daemon/src/adapters/git.ts

## pull-request

- daemon/src/domain/pull-request/
- daemon/src/application/pull-request/
- daemon/src/adapters/github.ts

## review

- daemon/src/domain/review/
- daemon/src/application/review/
- daemon/src/db/reviews.ts
- daemon/src/api/routes/reviews.ts

## planner-and-repos

- daemon/src/domain/planner/
- daemon/src/application/planner.ts
- daemon/src/domain/repo/
- daemon/src/application/repo/
- daemon/src/db/repos.ts
- daemon/src/db/planner-runs.ts
- daemon/src/adapters/goals.ts

## data

- daemon/src/db/schema.ts
- daemon/src/db/tables.ts
- daemon/src/db/index.ts
- daemon/src/db/orm.ts
- daemon/src/db/sql.ts
- daemon/src/api/contract.ts

## dashboard

- app/src/
