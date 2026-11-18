---
paths:
  - 'daemon/scripts/**'
  - 'daemon/test/architecture/**'
  - 'daemon/test/tooling/**'
  - '.github/**'
---

# Working on the checks

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **Coverage floors only rise.** (`rule:coverage-floors`)
  - `pnpm coverage` runs the daemon tests with coverage and prints line and branch coverage per group: `domain/<context>`, `db`, `adapters`, `application/<context>`, `api`, `cli`.
  - It fails when a group drops below its floor on `COVERAGE_FLOORS` (`daemon/scripts/lib/progress.ts`), and says to raise a floor beaten by more than 2 points; never lower one.
  - A new group gets a floor at its numbers rounded down. `docs/reference/coverage.md` lists the floors; CI runs `pnpm coverage`.
- **CI runs nothing a task's check skips.** Every `run:` step in `.github/workflows/` is a part of `check:fast` or an extra check of `pnpm check:task` (`daemon/scripts/lib/check-task.ts`), or setup listed with its reason, and each check step is named. A new CI check goes into `check:task` too, so a worker whose tests passed isn't failed by one it never ran. (`rule:ci-parity`)

## The checks in detail

- **`pnpm coverage`** runs the tests with V8's coverage, reported by `c8`, against the floors. It is what `check:fast` runs in place of `pnpm test`. CI splits it across three runners with `--shard <i>/3` and judges the merged counts with `--merge`. `--weigh` re-measures each test file's duration in `daemon/scripts/lib/test-weights.json`, which balances the shards.
- **`pnpm check:rust`** runs fmt, clippy and the tests of `app/src-tauri`. It is not part of `pnpm check`; CI runs it via `.github/workflows/rust.yml` whenever `app/src-tauri` changes.
- **`pnpm test:ui`** runs Playwright specs, light and dark screenshots and a contrast check in `app/e2e/`, against the Vite dev server and a daemon on a scratch home seeded with a task in every stage. `check:task` runs it; CI does not.
- **`pnpm test:github`** runs the whole lifecycle on a throwaway GitHub repo named by `AGENTDECK_GITHUB_E2E_REPO`. Opt-in, run by a person, never in CI: `docs/github-e2e.md`.
- **The lists that only shrink** are in `daemon/scripts/lib/progress.ts`: a new entry fails, and so does an entry that no longer applies. `docs/reference/progress.md` counts what is left.
- **`daemon/test/architecture/architecture.test.ts`** checks the Boundaries in `CLAUDE.md`, plus the dependency, migration and process-group rules. Each failure names the file, line and rule.
- **A new rule** gets a line with its id in `CLAUDE.md` and a test named `[its-id]`, or goes on `UNCHECKED` in `daemon/scripts/lib/rules.ts` with its reason. `pnpm rules` prints each rule with its checks.
