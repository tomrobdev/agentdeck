# Review areas

The areas the `review-area` skill reviews AgentDeck in. One heading per area, then the path prefixes it covers (a folder ends in `/`). Areas are slices down through the layers, one per aggregate or feature, named after the bounded contexts in `GLOSSARY.md` where they can be; the layers themselves are checked by `daemon/test/architecture.test.ts`. A file may sit in two areas. Every file under `daemon/src/` and `app/src/` is in an area, and every path listed here exists: `daemon/test/review-areas.test.ts` checks both, so a task that adds a file adds it here.

Groups for a session: **work** is task-use-cases, task-events, task-store and task-links; **landing** is pull-request and review; **runs** is run and sync.

## plan

- daemon/src/domain/work/plan.ts
- daemon/src/domain/work/plan-link.ts
- daemon/src/application/work/plans.ts
- daemon/src/application/work/plan-link.ts
- daemon/src/adapters/plan-file.ts
- daemon/src/db/work/plans.ts
- daemon/src/api/routes/work/plans.ts
- app/src/components/task/PlanCard.vue
- docs/plan-format.md

## task-links

Builds on and After links: a task's dependencies and dependents.

- daemon/src/domain/work/link.ts
- daemon/src/application/work/dependencies.ts
- daemon/src/application/work/links.ts
- daemon/src/db/work/task-links.ts

## task-context

What a session or worker is told about a task: the agent context digest, prompt path warnings, the proposal check and prompt sections.

- daemon/src/domain/operations/digest.ts
- daemon/src/domain/work/read/event-text.ts
- daemon/src/domain/work/prompt-paths.ts
- daemon/src/domain/work/proposal-check.ts
- daemon/src/application/operations/digest.ts
- daemon/src/application/work/live-context.ts
- daemon/src/application/work/prompt-paths.ts
- daemon/src/application/work/proposal-check.ts
- app/src/components/task/ProposalCheckCard.vue
- app/src/components/task/ApproveDialog.vue
- app/src/composables/useApprovals.ts
- app/src/lib/approveDialog.ts
- daemon/src/cli/context.ts
- daemon/src/cli/operations/agent-context.ts

## task-use-cases

The task entity, its lifecycle, and the person-facing use cases, CLI and routes.

- daemon/src/domain/work/task.ts
- daemon/src/domain/work/lifecycle.ts
- daemon/src/domain/work/history.ts
- daemon/src/domain/work/checkout.ts
- daemon/src/domain/work/ids.ts
- daemon/src/domain/work/needs.ts
- daemon/src/domain/work/rules.ts
- daemon/src/domain/work/stage.ts
- daemon/src/domain/work/start.ts
- daemon/src/domain/work/read/listing.ts
- daemon/src/domain/work/read/files.ts
- daemon/src/domain/work/read/since.ts
- daemon/src/application/work/tasks.ts
- daemon/src/application/work/task-views.ts
- daemon/src/application/work/files.ts
- daemon/src/api/routes/work/tasks.ts
- daemon/src/api/routes/work/files.ts
- daemon/src/cli/work/tasks.ts
- daemon/src/domain/work/index.ts

## task-events

Status changes and what follows them: domain events, the follow-ups table, task_events as the outbox, and settling.

- daemon/src/domain/work/follow-ups.ts
- daemon/src/domain/work/task-writes.ts
- daemon/src/application/landing/settle.ts
- daemon/src/application/landing/person-events.ts
- daemon/src/db/work/task-events.ts
- docs/adr/0004-task-events-outbox.md

## task-store

- daemon/src/db/work/tasks.ts
- daemon/src/db/work/tasks-columns.ts
- daemon/src/db/work/tasks-pr.ts
- daemon/src/db/work/tasks-queries.ts
- daemon/src/db/work/tasks-status.ts
- daemon/src/db/mappers.ts
- daemon/src/application/ports/repositories/work.ts

## run

The run's lifecycle: the worker, the claude process, resuming, prompts, logs, the live view, unblock runs, review runs and escalation.

- daemon/src/domain/runs/run.ts
- daemon/src/domain/runs/prompt.ts
- daemon/src/domain/runs/unblock.ts
- daemon/src/domain/runs/review.ts
- daemon/src/domain/runs/escalate.ts
- daemon/src/application/work/escalate.ts
- daemon/src/domain/runs/translate/
- daemon/src/domain/repos/protected-edits.ts
- daemon/src/application/runs/worker.ts
- daemon/src/application/runs/claude-run.ts
- daemon/src/application/runs/unblock.ts
- daemon/src/application/runs/review.ts
- daemon/src/domain/runs/verify.ts
- daemon/src/application/runs/verify.ts
- app/src/lib/verify.ts
- app/src/components/task/VerifyCard.vue
- app/src/components/task/VerifyFindings.vue
- daemon/src/application/runs/install-needs.ts
- daemon/src/application/ports/agent.ts
- daemon/src/application/ports/processes.ts
- daemon/src/application/ports/run-log.ts
- daemon/src/adapters/claude.ts
- daemon/src/adapters/processes.ts
- daemon/src/adapters/run-log.ts
- daemon/src/adapters/protected-edits.ts
- daemon/src/db/runs/runs.ts
- daemon/src/application/ports/repositories/runs.ts
- daemon/src/domain/runs/index.ts
- daemon/src/adapters/shell.ts
- daemon/src/api/log-stream.ts

## sync

- daemon/src/application/runs/sync.ts
- daemon/src/application/work/checkout-locks.ts
- daemon/src/application/ports/workspace.ts
- daemon/src/domain/work/branch.ts
- daemon/src/domain/runs/sync.ts
- daemon/src/domain/runs/resolve.ts
- daemon/src/adapters/git.ts
- daemon/src/adapters/workspace.ts

## pull-request

Pull requests, checks, merge requests, merging and auto-merge.

- daemon/src/domain/landing/auto-merge.ts
- daemon/src/domain/landing/checks.ts
- daemon/src/domain/landing/conflict.ts
- daemon/src/domain/landing/merge-request.ts
- daemon/src/domain/landing/merge.ts
- daemon/src/domain/landing/refresh.ts
- daemon/src/domain/landing/pr.ts
- daemon/src/domain/landing/pr-retry.ts
- daemon/src/domain/landing/summary.ts
- daemon/src/application/landing/auto-merge.ts
- daemon/src/application/landing/fix-checks.ts
- daemon/src/application/landing/check-failures.ts
- daemon/src/application/landing/merge-requests.ts
- daemon/src/application/landing/merge.ts
- daemon/src/application/landing/open-pr.ts
- daemon/src/application/landing/refresh.ts
- daemon/src/application/ports/code-host.ts
- daemon/src/adapters/github.ts
- daemon/src/api/routes/landing/pull-requests.ts
- daemon/src/cli/landing/pull-requests.ts
- daemon/src/domain/landing/index.ts

## review

- daemon/src/domain/landing/review.ts
- daemon/src/domain/landing/review-gate.ts
- daemon/src/domain/landing/address.ts
- daemon/src/application/landing/reviews.ts
- daemon/src/application/landing/address.ts
- daemon/src/db/landing/reviews.ts
- daemon/src/application/ports/repositories/landing.ts
- daemon/src/api/routes/landing/reviews.ts

## run-stats

`agentdeck stats` and the scorecard: read-only reporting over runs.

- daemon/src/domain/insights/
- daemon/src/application/insights/
- daemon/src/db/insights/stats.ts
- daemon/src/application/ports/repositories/insights.ts
- daemon/src/cli/insights/stats.ts

## scheduler

- daemon/src/application/scheduler/
- daemon/src/application/capacity/
- daemon/src/domain/capacity/
- daemon/src/db/capacity/usage.ts
- daemon/src/application/ports/repositories/capacity.ts
- daemon/src/daemon.ts

## planner-and-repos

- daemon/src/domain/proposals/
- daemon/src/application/proposals/
- daemon/src/domain/repos/
- daemon/src/application/repos/
- daemon/src/db/repos/repos.ts
- daemon/src/db/proposals/planner-runs.ts
- daemon/src/application/ports/repositories/repos.ts
- daemon/src/application/ports/repositories/proposals.ts
- daemon/src/adapters/goals.ts
- daemon/src/adapters/repo-root.ts
- daemon/src/api/routes/repos/repos.ts
- daemon/src/cli/repos/repos.ts

## operations

The daemon itself: health, the headline, restart and reload, notifications, settings and the service.

- daemon/src/domain/operations/
- daemon/src/application/operations/
- daemon/src/application/ports/notifier.ts
- daemon/src/application/ports/service.ts
- daemon/src/application/ports/source.ts
- daemon/src/adapters/notify.ts
- daemon/src/adapters/service.ts
- daemon/src/adapters/watch.ts
- daemon/src/adapters/caffeinate.ts
- daemon/src/adapters/daemon-api.ts
- daemon/src/adapters/daemon-log.ts
- daemon/src/db/operations/notifications.ts
- daemon/src/db/operations/settings.ts
- daemon/src/application/ports/repositories/operations.ts
- daemon/src/api/routes/operations/daemon.ts
- daemon/src/api/routes/operations/settings.ts
- daemon/src/cli/operations/daemon.ts
- daemon/src/cli/operations/daemon-client.ts
- daemon/src/cli/operations/settings-args.ts
- daemon/src/cli/operations/daemon-args.ts
- daemon/src/db/changes.ts

## wiring

The App object, the ports and repositories, the composition root and the entry points' plumbing.

- daemon/src/application/ports/app.ts
- daemon/src/application/ports/repositories/index.ts
- daemon/src/application/ports/goals.ts
- daemon/src/application/actions.ts
- daemon/src/application/shared/
- daemon/src/compose.ts
- daemon/src/cli.ts
- daemon/src/cli/commands.ts
- daemon/src/api/http.ts
- daemon/src/api/server.ts
- daemon/src/api/wire.ts
- docs/adr/0005-few-deep-ports.md
- daemon/src/domain/shared/
- daemon/src/config.ts
- daemon/src/cli/format.ts
- daemon/src/cli/help.ts

## data

- daemon/src/db/schema.ts
- daemon/src/db/tables.ts
- daemon/src/db/index.ts
- daemon/src/db/orm.ts
- daemon/src/db/sql.ts
- daemon/src/db/types-check.ts
- daemon/src/api/contract.ts
- daemon/src/api/contract/files.ts
- daemon/src/api/contract/insights.ts
- daemon/src/api/contract/landing.ts
- daemon/src/api/contract/operations.ts
- daemon/src/api/contract/repos.ts
- daemon/src/api/contract/runs.ts
- daemon/src/api/contract/work.ts
- daemon/src/api/contract-check.ts

## dashboard

- app/src/
