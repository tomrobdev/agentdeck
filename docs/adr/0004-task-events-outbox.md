# ADR 0004: `task_events` is the outbox, with no event sourcing

Status: accepted, 2026-11-07

A task's state is the row in `tasks`; `task_events` records what happened to it, written in the same statement as the change, and is read by the dashboard's history and by notifications. Nothing rebuilds a task from its events. Event sourcing would need every writer to append events and every reader to fold them, and the CLI and the daemon are separate processes that share only the database: a CLI change must reach the scheduler on its next tick without an in-process event bus, so the table is the message channel and the row is the truth. The cost is that the row and its events could disagree if a writer skipped one, so status changes go only through `applyEvent`.

## Consequences

- No in-memory event bus and no module-level state in `application/`.
- Consumers poll `task_events` by id; they never assume the daemon was the writer.
