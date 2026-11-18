---
paths:
  - 'app/src/**'
  - 'app/e2e/**'
---

# Working in `app/src/`

`CLAUDE.md` states each rule in a line. This file has the detail of the rules that apply here and how to work here; it loads when a file it covers is opened. `daemon/test/architecture/dashboard-layout.test.ts` checks the layout.

## Rules

- **`app/src/` is grouped by the daemon's bounded contexts, as the daemon is.** `MAY_IMPORT` in `daemon/scripts/lib/dashboard-layout.ts` is the rule, and the Dashboard section of `docs/architecture.md` is generated from it. (`rule:dashboard-layout`)
  - Not split by context:
    - `api/`: `types.ts`; `http.ts` for the request helpers, `refreshAll` and `retryQuery`; and one file per context (`work.ts`, `runs.ts`, `landing.ts`, `repos.ts`, `operations.ts`, `insights.ts`), each with its calls object (`workApi` and the like) and the query options for those calls, each imported by its own name.
    - `platform/`: the Tauri shell, build commit, theme.
    - `styles/`.
  - The layers `lib/`, `composables/` and `components/` each have the same context folders (`work/`, `runs/`, `landing/`, `repos/`, `operations/`, `insights/`) plus what they share:
    - `lib/`: pure helpers in kebab-case files, and the wording of each context in its `<context>-wording.ts` or `run-wording.ts`; times in `shared/time.ts`. Rules come from the daemon's `domain/`, never copied, and a file re-exports no name it imports. Shared: `lib/shared/`.
    - `composables/`: `useX` functions. Shared: `composables/shared/`.
    - `components/`. Shared: `components/ui/` (with `menu/`, `disclosure/`, `form/` and `status/`).
  - A context has a sub-folder only where it has the same one in every layer that needs it (`work/queue/`, `work/files/`).
  - `pages/` holds one component per route (`QueuePage`, `TaskPage`, `InsightsPage`, each reading its own queries), and `components/layout/` the app's frame and `Overlays.vue` (the panels, dialogs, key sheet, palette and toaster, shown from `useShell`'s state). Both combine the contexts.
  - `App.vue` is only the frame: providers, header, the `RouterView`, status bar and overlays.
  - `router.ts` is the route table (Vue Router, hash history, typed named routes, each page's props from its route). Nothing but it imports a page, and `vue-router` is imported only there, in `App.vue`, `main.ts`, composables and components (`PACKAGE_AREAS`).
  - `composables/shared/useShell.ts` is the window's shared state (open panel, palette, key sheet, merge dialog, selected task), so any component opens a panel itself instead of emitting up to App.
  - Imports point down `pages/` → `components/` → `composables/` → `lib/` → `api/`. Within a layer a context imports only itself and the shared folder, except that `work/` may import `runs/` and `landing/` (the queue and the task overview show a run's summary, a pull request and the merge buttons).
- **The API's request and response types are in `api/contract/<context>.ts`, which import only types, and only from `domain/` and each other.** (`rule:contract-types`)
  - The dashboard imports each from its own file, through `app/src/api/types.ts`.
  - Each route names the type it answers with (`route<T>` in `api/http.ts`), and `api/contract-check.ts` checks the request types against the use cases, so `pnpm typecheck` fails when a use case's type drifts from them.
- **The router is the only navigation.** Nothing under `app/src/` reads `location.hash`, calls `history.pushState` or `history.replaceState`, or listens to `hashchange`, and `createRouter` is called only in `app/src/router.ts`. (`rule:dashboard-router`)

## How to

- A new file goes in its context first, then its layer. Its context is the daemon context that owns its word (`GLOSSARY.md`): verify and the run log are Runs, reviews and merging are Landing, approving a proposal, the changed files, the palette and the queue's views are Work, the activity pill is Operations. Then: a pure helper in `lib/<context>/`, a `useX` function in `composables/<context>/`, a component in `components/<context>/`. What every context uses goes in `lib/shared/`, `composables/shared/` or `components/ui/`; a page for a route in `pages/`; the app's frame in `components/layout/`.
- `App.vue` is the frame only: providers, header, the `RouterView`, status bar and `components/layout/Overlays.vue`. It keeps no window state and passes nothing down. A route gets a named, typed entry in `router.ts` (its `RouteNamedMap` too) and a page in `pages/`, which reads its own queries (the query cache is shared, so a second `useQuery` of the same key costs nothing) and gets the route's params as props from the route's `props` function, never from `useRoute`; only `router.ts` imports a page. `vue-router` is imported only in `router.ts`, `App.vue`, `main.ts`, composables and components (`PACKAGE_AREAS` in `daemon/scripts/lib/dashboard-layout.ts`).
- Adding a route: a typed entry in `RouteNamedMap` and the route table in `router.ts`, its page loaded with `() => import('#pages/XPage.vue')` (the queue is the one eager page), a `meta.title` for the window title (the task page sets its own once the task has loaded), and links as `RouterLink` or `router.push`, never `location.hash`, `history.pushState` or `hashchange` (`rule:dashboard-router`). An unknown path redirects to the queue and an unknown task tab to Overview; Back to the queue restores the list's scroll through `data-scroll="queue"`.
- The window's shared state (the open panel, the palette, the key sheet, the merge dialog, the selected task) is `useShell` in `composables/shared/`. A component opens a panel or the palette by calling it, never by emitting up to App. A new overlay is shown by `Overlays.vue` from a ref there.
- A new API call goes on its context's calls object in `api/<context>.ts` (`workApi` in `work.ts`, `runsApi`, `landingApi`, `reposApi`, `operationsApi`, `insightsApi`), and a query option for it beside it in the same file. The request helpers (`get`, `post`, `del`, `qs`), `API_BASE`, the errors, `refreshAll` and `retryQuery` are in `api/http.ts`. A query key keyed by a commit starts with `'at'` and the commit, so `refreshAll` leaves it alone once the commit is known.
- Wording (how the dashboard says what the daemon reports) is a pure helper like any other: times and durations in `lib/shared/time.ts`, and each context's in `lib/<context>/<context>-wording.ts` (`run-wording.ts` for Runs). `api/` holds no wording.
- A context gets a sub-folder only where it has the same one in every layer that needs it (`work/queue/`, `work/files/`).
- A context imports only itself, its layer's shared folder and the layers below; `work/` may also import `runs/` and `landing/`, and `operations/` `runs/` and `landing/`. When a context needs another's piece, the piece belongs in the shared folder or the page combines the two.
- `.ts` files in `lib/` and `composables/` are kebab-case (`task-view.ts`); components are PascalCase `.vue` files, composables `useX.ts`.
- Rules come from the daemon's `domain/` (imported through a context's `index.ts`), never copied: a yes-or-no question about a task's status is the daemon's, and the dashboard-layout test fails a new one.
- A file in `lib/` exports only what it declares. It never re-exports a name it imports (`export { x } from …`, or `export { x }` of an imported `x`): a caller imports a daemon rule from `domain/<context>/index.ts` and any other name from the file that declares it. The dashboard-layout test fails a re-export.
- Every import uses the `#` prefix of its folder, never `./` or `../`, same-folder ones included (`rule:absolute-imports`): `#api/`, `#lib/`, `#composables/`, `#components/`, `#pages/`, `#platform/`, `#styles/`, `#src/` (`App.vue`, `router.ts`), `#e2e/`, `#daemon/` for the daemon's `domain/` and `api/contract/` (`#daemon/domain/work/index.ts`; nothing else in the daemon resolves) and `#docs/` for `docs/plans/`. An import names its file with its extension (`#lib/shared/time.ts`, `#components/ui/Chip.vue`): a `#` import is resolved as written, by TypeScript and by Node, which runs the daemon's tests of `lib/` files. `pnpm imports:fix` rewrites a relative or extensionless import for you.
- Moving a file: `git mv` it so it shows as a rename, rewrite its importers, move its line in `docs/review-areas.md`, and run `pnpm docs:gen` so the Dashboard section of `docs/architecture.md` counts it.
- Write no code comment in a `.vue` template or script but a file's leading one-line `//` comment (`rule:code-comments`): put the reason in a name or a type.
