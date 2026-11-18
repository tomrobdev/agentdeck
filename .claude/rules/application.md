---
paths:
  - 'daemon/src/application/**'
  - 'daemon/src/compose.ts'
  - 'daemon/src/daemon.ts'
---

# Working in `application/`

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **`application/` holds the use cases and imports only itself, `domain/` and `config.ts`.** (`rule:ports`)
  - It reaches the database through the repository interfaces it declares in `ports/repositories/`: one file per context, re-exported by its `index.ts`, in domain types. `db/` implements them, and an interface lists only what use cases call.
  - It reaches the I/O through the other ports in `ports/` (`Agent`, `CodeHost`, `Workspace`, `Source` and the rest), whose real adapters `compose.ts` builds. Only `compose.ts` names `db/` and `adapters/`.
  - Every use case takes `app: App` (`ports/app.ts`: the repositories and the ports, one object).
  - It is in one folder per context, as in `domain/`, with `scheduler/scheduler.ts` and `actions.ts` above them and `shared/input.ts` below them:
    - `runs/worker.ts`, and `runs/sync.ts` (syncing task branches with the base branch, and its resolve run).
    - `proposals/planner.ts`.
    - `landing/merge/merge.ts` and `landing/pull-request/refresh.ts`: merging a PR, and keeping open PRs' state fresh.
    - `landing/settle.ts`: every status change and its follow-ups (`FOLLOW_UPS` in `domain/work/lifecycle/follow-ups.ts`); the only caller of `applyEvent`.
    - `work/plans.ts`, and `work/checkout-locks.ts` (the sync and merge locks).
    - `repos/doctor.ts`.
    - `operations/digest.ts`: the digest, run by `agentdeck context`; `work/live-context.ts` reads the open tasks for it.
    - `operations/doctor.ts`: `agentdeck doctor`, the daemon's health, judged in `domain/operations/health.ts`.
    - The person-facing use cases: `repos/repos.ts`, `work/tasks.ts`, `landing/person-events.ts` (a person's lifecycle events, through `settle.ts`), `landing/review/reviews.ts` and `operations/settings.ts`.
  - The contexts import each other one way: proposals → runs → landing, repos → work → operations → capacity, and insights only `shared/`.
  - Request parsing and `ActionError` are in `shared/input.ts`.
- **`actions.ts` re-exports the use cases for the CLI and the API; it is the only application module they import.** (`rule:actions-only`)
- **The database is the only state the processes share: application code keeps no module-level state other than a lock or a cache of immutable results.** A CLI change reaches the scheduler on its next tick. (`rule:no-module-state`)
- **`src/compose.ts` builds the `App` on the database and the real adapters, for the CLI and the daemon. Nothing else builds an `App`.** (`rule:composition-root`)
  - Tests build theirs with `testApp` in `daemon/test/fixtures/fixtures.ts`.
  - `src/daemon.ts` (`runDaemon`) wires the source watcher (the `Source` port), the API and the scheduler on the App it is given. It logs and exits through callbacks and throws; `cli/operations/daemon.ts` prints and exits.
- **Every `claude` runs in its own process group** with its pid recorded on the run, so crash recovery can stop it. (`rule:claude-process-group`)

## How to

- A use case takes `app: App` (`ports/app.ts`), reads state through it, decides with `domain/`, then acts through an adapter. Keep the decision in `domain/` so it can be tested without I/O.
- `App` is built in `src/compose.ts` for the daemon and the CLI, and with `testApp` in `daemon/test/fixtures/fixtures.ts` for tests. A new port goes on `Ports` in `ports/app.ts`, with its real adapter in `compose.ts` and its test one in `fixtures.ts`.
- Keep no state between calls: the CLI runs the same use cases in its own process, and the database is all the processes share.
- Adapters report back through callbacks (`onUsage` in `runClaude`); they never call `db/`.
- Add a person-facing use case to `repos/repos.ts`, `work/tasks.ts`, `landing/person-events.ts`, `landing/reviews.ts` or `operations/settings.ts`, and re-export it from `actions.ts`.
- A status change goes through `landing/settle.ts`: `settle` for the daemon's events, `applyPersonEvent` for a person's; nothing else calls `applyEvent`. The event's follow-ups come from `FOLLOW_UPS` (`domain/work/follow-ups.ts`), and `task_events` is their outbox: `settle` runs them at once, and a person's wait for the daemon's tick (`followUpPending`), which also runs any a crash cut off. A follow-up must be safe to repeat.
- Tests use real git in a temporary repo and the fake `claude` (`daemon/test/fixtures/fake-claude.mjs`) rather than mocking each call.
- Anything that starts `claude` runs in its own process group with its pid recorded on the run.
- Write no code comment but the file's leading one-line comment (`rule:code-comments`): put the reason in a name, a type or a test.
