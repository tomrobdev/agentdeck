# ADR 0006: Who may call the daemon's API

Status: accepted, 2026-11-17

## Context

The daemon's API listens on `127.0.0.1:4317`, and checked one thing: a request that carries an `Origin` must come
from the dashboard. Two kinds of callers got past it.

- **A web page, through DNS rebinding.** A page on a name that later resolves to `127.0.0.1` makes same-origin GETs,
  which carry no `Origin`. Against the live daemon, a GET with `Host: attacker.example:4317` answered 200 with the
  settings, the repos, task prompts, files at a task's head and run logs.
- **A worker.** The sandbox's `allowLocalBinding` (ADR 0001), there so tests can start a local server, also lets
  sandboxed commands connect to every localhost port. A worker on task #189 called `GET /api/status` from its
  sandbox and got the answer. Any local process sends no `Origin`, so it could also approve, merge, change settings
  or delete a repo. For a worker the API was the one way to write outside its worktree.

## Options considered

1. **Turn off `allowLocalBinding`.** Breaks every repo whose tests start a server. Rejected.
2. **Allow the sandbox only its own ports.** The sandbox has no rule for "ports this command opened". Rejected.
3. **A Unix socket with file permissions.** The sandbox can connect to Unix sockets too, and browsers can't reach
   one, so the dashboard would need a bridge in the Tauri shell. Rejected.
4. **A `Host` check, plus a token on writes that workers can't read.** **Chosen.**

## Decision

- Every request must name `127.0.0.1`, `localhost` or `[::1]` as its `Host` (any port), else 403. A rebound name
  fails this, whatever the page sends.
- Every write (any method but GET, HEAD and OPTIONS) must carry `Authorization: Bearer <token>`, else 401. Reads
  need no token: `EventSource` can't send one, and what they show a worker can already read from disk.
- The token is in `~/.agentdeck/api-token` (`$AGENTDECK_HOME/api-token`), mode 0600, made by whoever needs it first
  (`apiToken` in `daemon/src/config.ts`) and kept. `AGENTDECK_API_TOKEN` overrides it, as the dashboard's end-to-end
  tests do.
- The CLI reads the file. The Tauri shell reads it for its own writes and hands it to the dashboard (the `api_token`
  command). The Vite dev server serves it to the dev dashboard at `/__agentdeck/token`.
- Every run's settings file keeps the token out of reach: `sandbox.filesystem.denyRead` for its shell commands, and
  a `Read(//<token>)` deny rule for the file tools (`workerSettings` in `domain/runs/translate/sandbox.ts`).

## Consequences

- A worker can still read the API, as it can read the database. It can no longer write through it.
- With a repo's sandbox off, only the file tools are kept off the token: a shell command can read it. Turning the
  sandbox off already trusts the worker with the user's account.
- The planner runs without a settings file and may read files, but has no tool that makes a request.
- While the Vite dev server runs, its `/__agentdeck/token` hands the token to anyone on localhost, a sandboxed
  worker included. Only run it while you're developing the dashboard.
