# AgentDeck areas

One heading per area, then the path prefixes it covers (a folder ends in `/`). Areas are slices down through the layers, one per aggregate; the layers themselves are checked by `daemon/test/architecture.test.ts`. A file may sit in two areas. A change outside every area is named in the report as unmapped.

## plan

- daemon/src/domain/work/plan.ts
- daemon/src/application/plans.ts
- daemon/src/adapters/plan-file.ts
- daemon/src/db/plans.ts
- daemon/src/api/routes/plans.ts
- app/src/components/task/PlanCard.vue
- docs/plan-format.md

## task-links

Builds on and After links: a task's dependencies and dependents.

- daemon/src/domain/work/link.ts
- daemon/src/application/task/dependencies.ts
- daemon/src/application/task/links.ts

## task-context

What a session or worker is told about a task: the agent context digest, prompt path warnings and prompt sections.

- daemon/src/domain/work/read/digest.ts
- daemon/src/domain/work/prompt-paths.ts
- daemon/src/domain/work/sections.ts
- daemon/src/application/task/context.ts
- daemon/src/application/task/prompt-paths.ts

## task-use-cases

The task entity, its lifecycle, and the person-facing use cases, CLI and routes.

- daemon/src/domain/work/task.ts
- daemon/src/domain/work/lifecycle.ts
- daemon/src/domain/work/history.ts
- daemon/src/domain/work/read/listing.ts
- daemon/src/domain/work/needs.ts
- daemon/src/domain/work/rules.ts
- daemon/src/domain/work/stage.ts
- daemon/src/domain/work/start.ts
- daemon/src/application/task/tasks.ts
- daemon/src/application/task/task-views.ts
- daemon/src/application/task/files.ts
- daemon/src/application/landing/settle.ts
- daemon/src/api/routes/tasks.ts
- daemon/src/cli/tasks.ts

## task-store

- daemon/src/db/tasks.ts

## run

The run's lifecycle: the worker, the claude process, resuming, prompts, logs and the live view.

- daemon/src/domain/runs/run.ts
- daemon/src/domain/runs/prompt.ts
- daemon/src/domain/runs/translate/sandbox.ts
- daemon/src/domain/runs/translate/log.ts
- daemon/src/domain/runs/translate/live.ts
- daemon/src/application/run/worker.ts
- daemon/src/application/run/claude-run.ts
- daemon/src/adapters/claude.ts
- daemon/src/adapters/processes.ts
- daemon/src/adapters/run-log.ts
- daemon/src/db/runs.ts

## run-stats

`agentdeck stats` and the scorecard: read-only reporting over runs.

- daemon/src/domain/insights/scorecard.ts
- daemon/src/domain/insights/stats.ts
- daemon/src/application/run/stats.ts
- daemon/src/db/stats.ts
- daemon/src/cli/stats.ts

## scheduler

- daemon/src/application/scheduler/
- daemon/src/domain/capacity/
- daemon/src/db/usage.ts
- daemon/src/daemon.ts

## sync

- daemon/src/application/runs/sync.ts
- daemon/src/application/work/checkout-locks.ts
- daemon/src/domain/work/branch.ts
- daemon/src/domain/landing/sync.ts
- daemon/src/domain/runs/resolve.ts
- daemon/src/adapters/git.ts

## pull-request

- daemon/src/domain/landing/auto-merge.ts
- daemon/src/domain/landing/checks.ts
- daemon/src/domain/landing/conflict.ts
- daemon/src/domain/landing/merge-request.ts
- daemon/src/domain/landing/merge.ts
- daemon/src/domain/landing/pr.ts
- daemon/src/domain/landing/summary.ts
- daemon/src/application/pull-request/
- daemon/src/adapters/github.ts

## review

- daemon/src/domain/landing/review.ts
- daemon/src/domain/landing/address.ts
- daemon/src/application/review/
- daemon/src/db/reviews.ts
- daemon/src/api/routes/reviews.ts

## planner-and-repos

- daemon/src/domain/proposals/
- daemon/src/application/planner.ts
- daemon/src/domain/repos/
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
