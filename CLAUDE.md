# AgentDeck

macOS daemon that works through a queue of coding tasks with `claude -p`, one git worktree per task, paced to the user's Claude quota. `daemon/` is Node + TypeScript on `node:sqlite`; `app/` is the Tauri 2 + Vue 3 dashboard.

## Commands

| Command                                 | What it runs                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm test`                             | The daemon's tests.                                                                        |
| `pnpm typecheck`                        | `tsc` on the daemon and the app.                                                           |
| `pnpm format`                           | Prettier, whole repo.                                                                      |
| `pnpm check:fast`                       | `format:check`, `typecheck`, `db:check`, `coverage`.                                       |
| `pnpm check`                            | `check:fast`, then the SIGKILL crash test (`CRASH_ITERATIONS` runs, default 10).           |
| `pnpm check:task`                       | The one check a task's branch must pass, and the repo's `test_cmd`. See below.             |
| `pnpm coverage`                         | The tests with coverage, against the floors; `check:fast` runs it in place of `pnpm test`. |
| `pnpm check:rust`                       | fmt, clippy and tests of `app/src-tauri`. Not part of `pnpm check`.                        |
| `pnpm test:ui`                          | The dashboard end to end (Playwright, in `app/e2e/`). `check:task` runs it; CI does not.   |
| `pnpm test:github`                      | The whole lifecycle on a throwaway GitHub repo. Opt-in, never in CI: `docs/github-e2e.md`. |
| `node daemon/scripts/crash-test.mjs 10` | The crash test alone.                                                                      |
| `pnpm docs:gen`                         | Generate the architecture docs.                                                            |
| `pnpm imports:fix`                      | Rewrite relative imports to their `#` form (rule:absolute-imports).                        |
| `pnpm rules`                            | Print each rule with its checks.                                                           |

**`pnpm check:task`** runs `check:fast`, then, against `origin/main`:

- the crash test (5 runs) when the branch changes `daemon/src/application/runs/`, `daemon/src/application/scheduler/`, `daemon/src/adapters/process/processes.ts`, `daemon/src/adapters/claude/claude.ts` or `daemon/src/db/`;
- `check:rust` when it changes `app/src-tauri/`;
- `test:ui` when it changes `app/src/`, `app/e2e/`, `app/playwright.config.ts`, `daemon/src/api/contract/` or `daemon/src/api/routes/`.

It prints which it ran and why. The rules are in `daemon/scripts/lib/check-task.ts`.

@GLOSSARY.md

Use the words in the glossary in code, logs and UI. Plans are named `<task id>-<slug>.html` (`docs/plan-format.md`); attach one with `agentdeck add --plan <file>` (any path) or `agentdeck attach`, and other tasks follow it with `--plan <task number>`.

## Where the detail is

Each rule below is stated in a line. Its detail, and how to work in that part of the code, is in a file under `.claude/rules/` that loads when you open a file it covers. Read the file yourself before planning a change you have not opened a file for.

| Working in                                            | Read                            |
| ----------------------------------------------------- | ------------------------------- |
| any code                                              | `.claude/rules/code.md`         |
| `daemon/src/domain/`                                  | `.claude/rules/domain.md`       |
| `daemon/src/db/`                                      | `.claude/rules/db.md`           |
| `daemon/src/adapters/`                                | `.claude/rules/adapters.md`     |
| `daemon/src/application/`, `compose.ts`, `daemon.ts`  | `.claude/rules/application.md`  |
| `daemon/src/api/`, `daemon/src/cli/`                  | `.claude/rules/entry-points.md` |
| `app/src/`, `app/e2e/`                                | `.claude/rules/dashboard.md`    |
| `daemon/scripts/`, the architecture tests, `.github/` | `.claude/rules/checks.md`       |

The map of the code is `docs/architecture.md`.

## Boundaries

- **`daemon/src/` is layered. Imports point down the list: an outer layer may import an inner one, never the reverse.** The list is the sections below, inner layer first. <!-- rule:layers -->

### `domain/`

- **`domain/` is pure: no I/O and no imports from other layers.** <!-- rule:domain-pure -->

### `db/`

- **Queries live only in `db/`, through Drizzle** (raw `sql` only where the builder hides a guard). <!-- rule:sql-in-db -->
- **Every task status change is a guarded `UPDATE … WHERE status IN (…)`** (`applyEvent` in `db/work/tasks-status.ts`, the claim included), never a raw status write. <!-- rule:guarded-status -->

### `adapters/`

- **`adapters/` hold the I/O, in a folder per system they talk to.** They import `domain/` and `config.ts` only, and report through callbacks. <!-- rule:adapters-io -->

### `application/`

- **`application/` holds the use cases and imports only itself, `domain/` and `config.ts`.** <!-- rule:ports -->
- **`actions.ts` re-exports the use cases for the CLI and the API; it is the only application module they import.** <!-- rule:actions-only -->

### Entry points

- **Entry points are `api/` and `cli/`. They import `application/actions.ts`, `domain/` and the contract, never `db/` or `adapters/`: every store call is a use case.** <!-- rule:entry-points -->
- **The CLI calls the use cases in its own process, so it works while the daemon is down.** <!-- rule:cli-in-process -->
- **The database is the only state the processes share: application code keeps no module-level state other than a lock or a cache of immutable results.** A CLI change reaches the scheduler on its next tick. <!-- rule:no-module-state -->

### Composition root

- **`src/compose.ts` builds the `App` on the database and the real adapters, for the CLI and the daemon. Nothing else builds an `App`.** <!-- rule:composition-root -->

### Dashboard

- **The API's request and response types are in `api/contract/<context>.ts`, which import only types, and only from `domain/` and each other.** <!-- rule:contract-types -->
- **`app/src/` is grouped by the daemon's bounded contexts, as the daemon is**, in the layers `pages/` → `components/` → `composables/` → `lib/` → `api/`. `MAY_IMPORT` in `daemon/scripts/lib/dashboard-layout.ts` is the rule. <!-- rule:dashboard-layout -->

## Rules

`daemon/test/architecture/architecture.test.ts` checks the Boundaries above, plus the dependency, migration and process-group rules below. Each failure names the file, line and rule. The map of the code is `docs/architecture.md`. A new rule gets a check, or goes on the unchecked list with its reason (`daemon/scripts/lib/rules.ts`); `pnpm rules` prints each rule with its checks.

Several rules keep a list of today's exceptions in `daemon/scripts/lib/progress.ts`. Each such list **only shrinks**: a new entry fails, and so does an entry that no longer applies. `docs/reference/progress.md` counts what is left.

### Structure

- **No folder cycles.** Folders in `domain/` and in `application/` import each other without cycles, counting runtime and type imports. The cycles there today are on `ALLOWED_FOLDER_CYCLES`, a list that only shrinks. <!-- rule:folder-cycles -->
- **No folder over 12 files.** A folder under `daemon/src`, `app/src` or `daemon/test` has at most 12 files directly in it (subfolders do not count). Today's folders over the limit are on `OVERSIZED_FOLDERS`, a list that only shrinks. A listed folder may grow while it is listed. <!-- rule:folder-size -->
- **No source file over 400 lines.** A `.ts` or `.vue` file under `daemon/src` or `app/src` has at most 400 lines. Today's long files are on `LONG_FILES`, a list that only shrinks. <!-- rule:file-size -->
- **Files sit in context folders.** A file in `daemon/src/db`, `daemon/src/adapters`, `daemon/src/api/routes`, `daemon/src/cli` or `daemon/test` sits in a folder named for a context. <!-- rule:context-folders -->
- **Contexts are imported through their `index.ts`**, a file of named exports; nothing outside a context reaches into its files. <!-- rule:contexts -->
- **Imports are absolute.** Every import, same-folder ones included, uses the `#` prefix of its layer and names its file with its extension, never `./` or `../`. `pnpm imports:fix` rewrites them. <!-- rule:absolute-imports -->
- **No `export *`.** A file that re-exports names what it re-exports, so a reader sees where each name comes from, and there are no barrel files: the dashboard imports `api/work` or `api/http`, not `api/`. A context's `index.ts` is its interface, not a barrel. <!-- rule:no-export-star -->
- **Every source file is in a review area.** `docs/review-areas.md` maps `daemon/src/` and `app/src/` into the areas the `review-area` skill reviews; a new file goes under its area, and a moved one is moved there too. <!-- rule:review-areas -->

### Code

- **Code comments only where a tool reads them.** In `daemon/src`, `app/src`, `daemon/test` and `daemon/scripts`, write no comment but a file's leading one-line `//` comment and the few other kinds a tool reads. Say the rest in a name, a type, a test or the docs. <!-- rule:code-comments -->
- **Strict types.** No explicit `any`, no non-null assertion `!`, and every `switch` on a union of literals covers every member or ends in a default that assigns the value to `never`. <!-- rule:strict-types -->
- **A deterministic domain.** `domain/` reads no clock (`Date.now()`, `new Date()` without arguments), no randomness (`Math.random()`, `crypto`) and no `process`: the time and random values are arguments. Checked with the strict types, on the same list. <!-- rule:domain-deterministic -->
- **Every domain function has a pure test.** Each function a context's `index.ts` exports is used in a test file that imports nothing from `db/`, `application/`, `adapters/`, the fixtures, `node:fs` or `node:child_process`. <!-- rule:domain-tests -->
- **Erasable TypeScript only.** Node runs `.ts` directly, so no enums, namespaces or constructor parameter properties. <!-- rule:erasable-ts -->
- **No new runtime dependencies** without a reason. The one there is, `drizzle-orm`, is pinned at exactly `1.0.0-rc.5` (no caret); use only its core query builder, not the relational query API. `pnpm db:studio` browses the live database. <!-- rule:no-runtime-deps -->
- **Use the glossary's words.** An `_Avoid_:` word in `GLOSSARY.md` appears nowhere in `daemon/src` or `app/src`, and "hold" is the governor's word alone. <!-- rule:vocabulary -->

### Model and database

- **Schema changes are appended as new migration steps.** Never edit a step that has shipped. <!-- rule:migrations-append -->
- **Models, not rows.** A store reads a whole row of `tasks`, `repos` or `runs` only through `db/mappers.ts`. <!-- rule:models-not-rows -->
- **A task write with a rule is a domain function** in `domain/work/lifecycle/task-writes.ts`; the task store only persists it under its guard. <!-- rule:task-writes -->
- **Ids are branded** (`TaskId`, `RepoId`, `RunId`, `ReviewId`, `PlannerRunId`): an entry point parses an id once, and a field named `…_id` or `…Id` is never typed `number`. <!-- rule:branded-ids -->
- **A state machine is a rule table in `domain/`** (`RULES` in `work/lifecycle/lifecycle.ts`, `COMMENT_MOVES` in `landing/review/review.ts`), and `pnpm docs:gen` lists it in `docs/reference/state-machines.md`. A state type no table drives is on the allow-list in `daemon/scripts/lib/model-docs.ts` with its reason; pull request state and merge requests are there until they are tables. <!-- rule:state-as-data -->

### Checks and working here

- **Coverage floors only rise.** `pnpm coverage` fails when a group drops below its floor on `COVERAGE_FLOORS`; never lower one. <!-- rule:coverage-floors -->
- **CI runs nothing a task's check skips.** Every `run:` step in `.github/workflows/` is a part of `check:fast` or an extra check of `pnpm check:task` (`daemon/scripts/lib/check-task.ts`), or setup listed with its reason, and each check step is named. A new CI check goes into `check:task` too, so a worker whose tests passed isn't failed by one it never ran. <!-- rule:ci-parity -->
- **Every `claude` runs in its own process group** with its pid recorded on the run, so crash recovery can stop it. <!-- rule:claude-process-group -->
- **Keep this checkout on `main`.** The installed daemon runs its `daemon/src/cli.ts`, so switching branches here swaps the live daemon's code. Try task branches from their worktrees. <!-- rule:main-checkout -->
- **The router is the only navigation.** Nothing under `app/src/` reads `location.hash`, calls `history.pushState` or `history.replaceState`, or listens to `hashchange`, and `createRouter` is called only in `app/src/router.ts`. <!-- rule:dashboard-router -->
- **Delegating to AgentDeck:** when to queue a task instead of doing it here, how to write it, and how to work in a task's worktree are in the `delegate` skill (`.claude/skills/delegate/SKILL.md`). <!-- rule:delegate-skill -->
