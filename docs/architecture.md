# Architecture

A map of AgentDeck's code, layers first. The block between `<!-- generated:layers -->` and `<!-- /generated -->` and every file in `docs/reference/` marked generated are written by `pnpm docs:gen` from the code (Claude's edit hook runs it after each edit under `daemon/src`), and `pnpm test` fails when they are stale. The two sections written by hand here are checked too: every file in `daemon/src/adapters/` must be named in the system context, and every identifier in backticks in them must be exported from `daemon/src`. The rules the layers follow are in CLAUDE.md. The decisions behind the design are in `docs/adr/`: [0001 worker sandbox](adr/0001-worker-sandbox.md), [0002 functional DDD](adr/0002-functional-ddd.md), [0003 one table, a rich aggregate, a flat API](adr/0003-one-table-rich-aggregate.md), [0004 `task_events` as the outbox](adr/0004-task-events-outbox.md), [0005 a few deep ports](adr/0005-few-deep-ports.md), [0006 who may call the API](adr/0006-api-access.md) and [0007 plan branches](adr/0007-plan-branches.md).

## Layers

What each layer of `daemon/src` holds and may import. The rule is `LAYERS` in `daemon/scripts/lib/layers.ts`: the architecture test enforces it and this section is generated from it.

<!-- generated:layers -->

| Layer          | Holds                                                                                                             | May import                                                  | Why                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `domain/`      | Entities and decisions, pure: task lifecycle, governor, prompts, plans                                            | nothing                                                     | domain/ is pure and imports no other layer                                                                 |
| `config.ts`    | Paths and constants                                                                                               | nothing                                                     | config.ts is read by every layer and imports none                                                          |
| `db/`          | Every SQL query, through Drizzle, and the migrations                                                              | `domain/`, `config.ts`                                      | db/ holds the SQL and knows only the domain                                                                |
| `adapters/`    | The I/O: claude, git, gh, processes, shell, notifications, launchd, run logs                                      | `domain/`, `config.ts`                                      | adapters import domain/ and config.ts only; they report through callbacks                                  |
| `application/` | The use cases, and the ports (repositories and other interfaces) they reach the database and the adapters through | `domain/`, `config.ts`                                      | application/ reaches the database and the adapters only through the ports it declares (application/ports/) |
| `compose.ts`   | Builds the App the use cases take, on the database and the real adapters                                          | `application/`, `adapters/`, `db/`, `domain/`, `config.ts`  | compose.ts builds the App and uses no entry point                                                          |
| `api/`         | The dashboard's HTTP API                                                                                          | `application/`, `domain/`, `config.ts`                      | entry points use application/actions.ts, domain/ and the contract; only compose.ts names db/ and adapters/ |
| `cli/`         | One file per command group of the agentdeck CLI                                                                   | `api/`, `application/`, `domain/`, `config.ts`, `daemon.ts` | entry points use application/actions.ts, domain/ and the contract; only compose.ts names db/ and adapters/ |
| `daemon.ts`    | Wires the source watcher, the API and the scheduler onto the App it is given                                      | `api/`, `application/`, `domain/`, `config.ts`              | daemon.ts gets its App from compose.ts and names neither db/ nor adapters/                                 |
| `cli.ts`       | The CLI entry point the launchd plist runs                                                                        | `cli/`, `application/`, `compose.ts`, `config.ts`           | cli.ts only dispatches to cli/                                                                             |

```mermaid
flowchart TD
  domain["domain/"]
  config_ts["config.ts"]
  db["db/"]
  adapters["adapters/"]
  application["application/"]
  compose_ts["compose.ts"]
  api["api/"]
  cli["cli/"]
  daemon_ts["daemon.ts"]
  cli_ts["cli.ts"]
  db --> domain & config_ts
  adapters --> domain & config_ts
  application --> domain & config_ts
  compose_ts --> application & adapters & db & domain & config_ts
  api --> application & domain & config_ts
  cli --> api & application & domain & config_ts & daemon_ts
  daemon_ts --> api & application & domain & config_ts
  cli_ts --> cli & application & compose_ts & config_ts
```

No import falls outside the rule.

<!-- /generated -->

## System context

```mermaid
flowchart LR
  dashboard["Dashboard (Tauri app)"]
  cli["agentdeck CLI"]
  subgraph daemon["Daemon (Node)"]
    api["api/"]
    scheduler["application/scheduler"]
    worker["application/runs"]
    db["db/"]
    claude["adapters/claude/claude.ts"]
    workspace["adapters/git/workspace.ts"]
    git["adapters/git/exec.ts, adapters/git/refs.ts,<br/>adapters/git/diffs.ts, adapters/git/worktrees.ts"]
    github["adapters/github/github.ts"]
    issues["adapters/github/issues.ts"]
    service["adapters/macos/service.ts"]
    notify["adapters/macos/notify.ts"]
    processes["adapters/process/processes.ts"]
    shell["adapters/process/shell.ts"]
    runlog["adapters/claude/run-log.ts"]
    planfile["adapters/local/plan-file.ts"]
    protectededits["adapters/local/protected-edits.ts"]
    goals["adapters/local/goals.ts"]
    reporoot["adapters/git/repo-root.ts"]
    watch["adapters/macos/watch.ts"]
    caffeinate["adapters/macos/caffeinate.ts"]
    daemonapi["adapters/local/daemon-api.ts"]
    daemonlog["adapters/local/daemon-log.ts"]
  end
  sqlite[("SQLite")]
  claudecli["claude -p"]
  gitbin["git"]
  ghbin["gh"]
  launchd["launchd"]
  notifications["Desktop notifications and ntfy"]
  dashboard -- HTTP --> api
  cli -- "use cases in its own process" --> db
  cli -- "propose and sync, over HTTP" --> api
  api --> scheduler
  scheduler --> worker
  worker --> db
  db --> sqlite
  worker --> claude --> claudecli
  worker -- "the Workspace port" --> workspace --> git --> gitbin
  worker --> github --> ghbin
  scheduler -- "the issue poll" --> issues --> ghbin
  workspace --> shell & reporoot
  claude --> processes
  worker --> runlog
  workspace -- "the run's plan, in the worktree" --> planfile
  workspace -- "edits under .claude/ the worker wrote out" --> protectededits --> git
  scheduler --> goals
  goals --> reporoot
  service --> launchd
  notify --> notifications
  watch -. "source changed" .-> scheduler
  caffeinate -. "keeps the Mac awake" .-> scheduler
  cli -- "agentdeck doctor" --> daemonapi & daemonlog
```

## Dashboard

<!-- generated:dashboard -->

Grouped by the daemon's contexts. Each layer has a folder per context, the shared one first (`components/ui/` in `components/`); the table counts each folder's files.

| Layer          | Holds            | shared | work | runs | landing | repos | operations | insights |
| -------------- | ---------------- | ------ | ---- | ---- | ------- | ----- | ---------- | -------- |
| `lib/`         | pure helpers     | 11     | 18   | 10   | 1       | 1     | 2          | 1        |
| `composables/` | `useX` functions | 8      | 17   | 2    | 2       | –     | 2          | –        |
| `components/`  | Vue components   | 53     | 37   | 12   | 7       | 4     | 11         | 2        |

Beside the layers:

- `api/`: 9 files
- `platform/`: 3 files
- `components/layout/`: 8 files
- `pages/`: 3 files

Imports:

- Point down `pages/` → `components/` → `composables/` → `lib/` → `api/`.
- Within a layer, a context imports only itself and the shared folder, which imports no context.
- `work/` may also import `runs/` and `landing/`: the queue and the task overview show a run's summary, a pull request and the merge buttons.
- `operations/` may also import `runs/` and `landing/`: the activity pill words a run, a sync and a merge request the way the task rows do.
- `pages/` and `components/layout/` combine the contexts.

Each area's rule and why: [dashboard](reference/dashboard.md), from `MAY_IMPORT` in `daemon/scripts/lib/dashboard-layout.ts`, which `daemon/test/architecture/dashboard-layout.test.ts` enforces.

<!-- /generated -->

## Flows

How the parts work together, one path at a time, each with a sequence diagram: a task's run, landing, a sync and its resolve run, a question, a task from a GitHub issue, a proposal, a plan branch, and a crash and resuming a run. They are in [flows](flows.md).

## Reference

- [Data model](reference/data-model.md), [migrations](reference/migrations.md) and [settings](reference/settings.md): the tables and their keys, the steps of `db/schema.ts`, and each setting with its default and meaning.
- [Task lifecycle](reference/state-machines.md#task-lifecycle): every status change and its event.
- [HTTP API](reference/routes.md): the routes and the use case each calls.
- [Adapters](reference/adapters.md): what each file in `daemon/src/adapters/` does.
- [Context map](reference/context-map.md): the folders under `domain/` and the imports between them.
- [Models](reference/models.md), [use cases](reference/use-cases.md) and [state machines](reference/state-machines.md): the entities, `application/actions.ts` and the rule tables. [Exceptions](reference/progress.md) counts what the rules still let through, and [coverage floors](reference/coverage.md) the least coverage each layer and context may have.
