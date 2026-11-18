---
paths:
  - 'daemon/src/**'
  - 'daemon/test/**'
  - 'daemon/scripts/**'
  - 'app/src/**'
  - 'app/e2e/**'
---

# Writing code anywhere in the repo

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened.

## Rules

- **Code comments only where a tool reads them.** (`rule:code-comments`)
  - This covers `daemon/src`, `app/src`, `daemon/test` and `daemon/scripts` (`.ts`, `.vue` script and template, `.mjs`).
  - The only comments are:
    - a file's leading one-line `//` comment (the architecture docs print it);
    - a `// @ts-expect-error` with its reason;
    - a `/// <reference>` directive;
    - a shebang;
    - the heading above a step of `MIGRATIONS` in `db/schema.ts` (the docs print it);
    - the comments on a type or interface and its fields in `domain/` and `api/contract/` (`pnpm docs:gen` prints them in the model docs);
    - a `// guard:` comment on raw `sql` in `db/` (rule:sql-in-db reads it).
  - Say the rest in a name, a type, a test or the docs.
  - No allow-list: `daemon/test/architecture/code-comments.test.ts` fails on any other comment, naming the file and line.
  - A repo's own limits on the code comments a task adds are `code_comment_max_lines` and `code_comment_max_percent`.
- **Imports are absolute.** (`rule:absolute-imports`)
  - Every import in `daemon/src`, `daemon/test`, `daemon/scripts`, `app/src` and `app/e2e`, same-folder ones included, uses the `#` prefix of its layer from its package's `imports` (`package.json`), never `./` or `../`, and names its file with its extension.
  - In the daemon: `#domain/`, `#application/`, `#db/`, `#adapters/`, `#api/`, `#cli/`, `#src/` (`compose.ts`, `config.ts`, `daemon.ts`, `cli.ts`), `#test/`, `#scripts/` and `#app/` (the dashboard's `lib/` and `api/types.ts`, for the daemon's tests).
  - In the app: `#api/`, `#lib/`, `#composables/`, `#components/`, `#pages/`, `#platform/`, `#styles/`, `#assets/`, `#src/`, `#e2e/`, `#daemon/` and `#docs/`.
  - `#daemon/` reaches only what `daemon/package.json` exports, its `domain/` and `api/contract/`; `#app/` and `#docs/` go through the root package's exports. Node, TypeScript, Vite and Playwright resolve them natively.
  - `pnpm imports:fix` (`daemon/scripts/absolute-imports.ts`) rewrites a relative import to its `#` form, and `daemon/test/architecture/absolute-imports.test.ts` fails on one, naming its file and line.
- **Strict types.** (`rule:strict-types`)
  - `daemon/tsconfig.json` and the app's tsconfigs turn on `noFallthroughCasesInSwitch`, `noImplicitReturns` and `noImplicitOverride` beyond `strict`.
  - Under `daemon/src` and `app/src` there is no explicit `any` (a type or `as any`: use `unknown` and narrow it) and no non-null assertion `!` (narrow the value, or `present` from `domain/shared/`).
  - Every `switch` on a union of literals covers every member or ends in a default that assigns the value to `never`.
  - `daemon/scripts/lib/strictness.ts` checks it with the TypeScript compiler; today's exceptions are on `STRICTNESS_EXCEPTIONS`, a list that only shrinks.
- **Files sit in context folders.** (`rule:context-folders`)
  - Files in `daemon/src/db`, `daemon/src/adapters`, `daemon/src/api/routes`, `daemon/src/cli` and `daemon/test` sit in a folder named for a context. For adapters that is an external system; for tests also `architecture`, `tooling`, `e2e`, `fixtures`, `api`, `cli`, `db`, `dashboard`.
  - The exception is the shared files `PLACED_FOLDERS` lists with a reason (`daemon/scripts/lib/layout.ts`).
  - Folders that still have loose files are on `UNPLACED_FOLDERS`, a list that only shrinks.
- **Use the glossary's words.** (`rule:vocabulary`)
  - An `_Avoid_:` word in `GLOSSARY.md` appears nowhere in `daemon/src` or `app/src`.
  - "Hold" (hold, holds, held, holding) is the governor's word alone (`domain/capacity/`, the scheduler's announcement, the `hold` notification kind); a repo or the daemon is paused, and anywhere else say wait or keep.
  - Other uses are on the check's allow-list, each with its reason.

## How to

- `pnpm format` and `pnpm imports:fix` fix what they can; `pnpm check:fast` says what is left.
- A list in `daemon/scripts/lib/progress.ts` only shrinks: fix the code rather than adding an entry.
