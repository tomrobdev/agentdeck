---
paths:
  - 'daemon/src/api/**'
  - 'daemon/src/cli/**'
  - 'daemon/src/cli.ts'
---

# Working in `api/` and `cli/`

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **Entry points are `api/` and `cli/`. They import `application/actions.ts`, `domain/` and the contract, never `db/` or `adapters/`: every store call is a use case.** (`rule:entry-points`)
  - `api/` is the dashboard's HTTP API, its routes in a folder per context.
  - `cli/` has one file per command group, in a folder per context.
  - `src/cli.ts` stays put: the installed launchd plist runs it.
- **The CLI calls the use cases in its own process, so it works while the daemon is down.** (`rule:cli-in-process`)
  - Only work that starts `claude` (propose, a sync that may start a resolve run) goes to the daemon over HTTP (`cli/operations/daemon-client.ts`). Which use cases those are is worked out from the code, by what reaches the `Agent` port's `run` (`daemon/scripts/lib/claude-starters.ts`).
  - Each entry point parses its own input (flags, request bodies) into the use case's typed input.
- **The API's request and response types are in `api/contract/<context>.ts`, which import only types, and only from `domain/` and each other.** (`rule:contract-types`)
  - The dashboard imports each from its own file, through `app/src/api/types.ts`.
  - Each route names the type it answers with (`route<T>` in `api/http.ts`), and `api/contract-check.ts` checks the request types against the use cases, so `pnpm typecheck` fails when a use case's type drifts from them.
- **Ids are branded.** (`rule:branded-ids`)
  - `TaskId`, `RepoId`, `RunId`, `ReviewId` and `PlannerRunId` (`domain/shared/id.ts`) are numbers the compiler keeps apart, erased at runtime.
  - An entry point parses an id once (`parseId`, `parseTaskIds`); stores return branded ids (the table columns say so in `db/tables.ts`), and use cases take them.
  - A domain or contract field named `…_id` or `…Id` is never typed `number`. A test makes an id with `asTaskId` and the like.

## How to

- A route or a command parses its input, calls one use case from `application/actions.ts`, and shapes the answer. It decides nothing itself.
- A new route names the type it answers with (`route<T>`), and that type goes in `api/contract/<context>.ts`.
- Changing a type the dashboard reads: follow the `model-change` skill.
- Write no code comment but the file's leading one-line comment and the comments on a contract type and its fields (`rule:code-comments`).
