# ADR 0002: Functional DDD, with types and functions

Status: accepted, 2026-11-07

The domain model is plain types and pure functions (`domain/`), not classes. A `Task` is a type, and a decision about it is a function from a task and an event to a result. Node runs `.ts` directly, so classes with constructor parameter properties, enums and namespaces are out anyway (erasable TypeScript only), and rows from `node:sqlite` are plain objects that a type describes without a wrapper. Pure functions need no I/O to test and can be called from the CLI, the daemon and the API alike. The cost is that nothing hides a record's fields, so the rules live in the functions that build and change one, and `daemon/test/architecture.test.ts` keeps `domain/` free of I/O.

## Consequences

- An aggregate is a type plus the functions that decide its changes, in one folder of `domain/`.
- A new rule goes in a function there, never in a store or a route.
