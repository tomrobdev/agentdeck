# Working in `app/src/`

How-to only. The rule statements (the layers, the context folders, which area may import which) are in CLAUDE.md's dashboard-layout line, and `MAY_IMPORT` in `daemon/scripts/lib/dashboard-layout.ts` is the rule `daemon/test/architecture/dashboard-layout.test.ts` checks.

- A new file goes in its context first, then its layer. Its context is the daemon context that owns its word (`GLOSSARY.md`): verify and the run log are Runs, reviews and merging are Landing, approving a proposal, the changed files, the palette and the queue's views are Work, the activity pill is Operations. Then: a pure helper in `lib/<context>/`, a `useX` function in `composables/<context>/`, a component in `components/<context>/`. What every context uses goes in `lib/shared/`, `composables/shared/` or `components/ui/`; a page for a route in `pages/`; the app's frame in `components/layout/`.
- A context gets a sub-folder only where it has the same one in every layer that needs it (`work/queue/`, `work/files/`).
- A context imports only itself, its layer's shared folder and the layers below; `work/` may also import `runs/` and `landing/`. When a context needs another's piece, the piece belongs in the shared folder or the page combines the two.
- `.ts` files in `lib/` and `composables/` are kebab-case (`task-view.ts`); components are PascalCase `.vue` files, composables `useX.ts`.
- Rules come from the daemon's `domain/` (imported through a context's `index.ts`), never copied: a yes-or-no question about a task's status is the daemon's, and the dashboard-layout test fails a new one.
- The daemon's tests (`daemon/test/dashboard/`, grouped by context like `lib/`) import some `lib/` files with Node, which needs the extension: a file a test imports, and every file it imports in turn, keeps `.ts` on its relative imports. Other dashboard files may leave it off.
- Moving a file: `git mv` it so it shows as a rename, rewrite its importers, move its line in `docs/review-areas.md`, and run `pnpm docs:gen` so the Dashboard section of `docs/architecture.md` counts it.
