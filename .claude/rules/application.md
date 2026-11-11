# Working in `application/`

How-to only. The rule statements (use cases connect domain, db and adapters; `actions.ts` is the only module entry points import; no module-level state) are in CLAUDE.md.

- A use case takes `app: App` (`ports/app.ts`), reads state through it, decides with `domain/`, then acts through an adapter. Keep the decision in `domain/` so it can be tested without I/O.
- `App` is built in `src/compose.ts` for the daemon and the CLI, and with `testApp` in `daemon/test/fixtures/fixtures.ts` for tests. A new port goes on `Ports` in `ports/app.ts`, with its real adapter in `compose.ts` and its test one in `fixtures.ts`.
- Keep no state between calls: the CLI runs the same use cases in its own process, and the database is all the processes share.
- Adapters report back through callbacks (`onUsage` in `runClaude`); they never call `db/`.
- Add a person-facing use case to `repos/repos.ts`, `work/tasks.ts`, `landing/person-events.ts`, `landing/reviews.ts` or `operations/settings.ts`, and re-export it from `actions.ts`.
- A status change goes through `landing/settle.ts`: `settle` for the daemon's events, `applyPersonEvent` for a person's; nothing else calls `applyEvent`. The event's follow-ups come from `FOLLOW_UPS` (`domain/work/follow-ups.ts`), and `task_events` is their outbox: `settle` runs them at once, and a person's wait for the daemon's tick (`followUpPending`), which also runs any a crash cut off. A follow-up must be safe to repeat.
- Tests use real git in a temporary repo and the fake `claude` (`daemon/test/fixtures/fake-claude.mjs`) rather than mocking each call.
- Anything that starts `claude` runs in its own process group with its pid recorded on the run.
- Write no code comment but the file's leading one-line comment (`rule:code-comments`): put the reason in a name, a type or a test.
