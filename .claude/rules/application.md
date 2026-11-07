---
paths:
  - 'daemon/src/application/**'
---

# Working in `application/`

How-to only. The rule statements (use cases connect domain, db and adapters; `actions.ts` is the only module entry points import; no module-level state) are in CLAUDE.md.

- A use case reads state through `db`, decides with `domain/`, then acts through an adapter. Keep the decision in `domain/` so it can be tested without I/O.
- Keep no state between calls: the CLI runs the same use cases in its own process, and the database is all the processes share.
- Adapters report back through callbacks (`onUsage` in `runClaude`); they never call `db/`.
- Add a person-facing use case to `repo/repos.ts`, `task/tasks.ts`, `review/reviews.ts` or `settings.ts`, and re-export it from `actions.ts`.
- Tests use real git in a temporary repo and the fake `claude` (`daemon/test/fake-claude.mjs`) rather than mocking each call.
- Anything that starts `claude` runs in its own process group with its pid recorded on the run.
