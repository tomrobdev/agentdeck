# AgentDeck

Always-on agent manager for macOS. A background daemon works through a queue of coding tasks with Claude Code (`claude -p`), one git worktree per task, paced to stay within your subscription usage. A Tauri + Vue app is the control panel.

## Layout (planned)

```
daemon/   Node + TypeScript daemon: queue, scheduler, workers, usage governor, API
app/      Tauri 2 + Vue 3 dashboard (queue, live logs, budget, settings)
launchd/  plist to keep the daemon running
```

## Milestones

1. Daemon core + CLI (queue, worker, worktrees)
2. Tauri + Vue dashboard
3. Usage governor + notifications
4. Planner + always-on (launchd, launch at login)

## Safety defaults

- Max 2 concurrent tasks
- Never pushes or merges; branches are left for review
- Per-repo allowed-tools list, no `--dangerously-skip-permissions`
- Daemon starts paused
