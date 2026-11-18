# Security

AgentDeck runs `claude` unattended on your machine, in your repos, so a flaw in it can matter.

## Reporting a problem

Report a vulnerability privately through GitHub: the **Security** tab of this repo, then **Report a vulnerability**. Please don't open a public issue for it.

Say what you did, what happened and what you expected. This is a personal project with no guaranteed response time, but security reports are read first.

## What AgentDeck relies on

- **Workers run in Claude Code's sandbox** (`docs/adr/0001-worker-sandbox.md`): a worker's shell commands can write only inside the task's worktree, and reach the network only at the hosts the repo allows.
- **The API listens on `127.0.0.1` only.** Anything that changes state needs the token in `~/.agentdeck/api-token`, and browser requests are accepted only from the dashboard (`docs/adr/0006-api-access.md`).
- **A repo's settings decide what happens without you:** opening pull requests, merging them, and approving the planner's proposals are each off until you turn them on.
