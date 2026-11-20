import { NOTIFY_KINDS } from '#domain/operations/index.ts';

export const CONTEXT_HELP = `  agentdeck clean <id>          remove the task's worktree (its branch is kept)
  agentdeck context [--repo r] [--since <event>]   the repo's live queue in a few lines, for an agent (default: this
                                  directory's repo); --since shows what changed after that event. --hook is the
                                  mode Claude Code's SessionStart and UserPromptSubmit hooks run (hook JSON on stdin)`;

export const DAEMON_HELP = `  agentdeck install             run the daemon at login via launchd (restarted if it dies)
  agentdeck uninstall
  agentdeck service [start|stop]  launchd status; start or stop the service, keeping its plist
  agentdeck restart [--now]     restart the service: pause new claims, wait until no task or planner run is active,
                                  restart, restore the pause state. --now restarts at once (a running task is requeued)
  agentdeck logs [-f] [-n lines]  print (or follow) ~/.agentdeck/logs/daemon.log
  agentdeck doctor [--json]     check the daemon: service, API, loaded commit, reload, stray claude processes, the log, gh,
                                  area reviews due (a warning, never a failure); each failed check names the command that
                                  fixes it (exit 1 if any fails; works with the daemon down)
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            land the plan PRs their landing policies allow, work the queue until empty, then exit
                                  (ignores pause; refused while the daemon runs)
  agentdeck pause | resume
  agentdeck drain               start no new task, let the work in flight finish (retries, resolve, unblock and review
                                  runs), then pause and send a 'drained' notification; resume ends a drain
  agentdeck status
  agentdeck settings              show concurrency, usage budget and notification settings
  agentdeck set <key> <value>     max_concurrent, five_hour_max, five_hour_soft, weekly_max, pace_slack (0..1),
                                  support_slots (0 to 4: room for review, unblock and verify runs beyond max_concurrent),
                                  notify_desktop (on|off), notify_events (${NOTIFY_KINDS.join(',')}), ntfy_topic, ntfy_server,
                                  planner_enabled (on|off), planner_interval_hours, planner_max_tasks, planner_model,
                                  default_model (a new task's model when neither it nor its repo names one),
                                  support_model (the model of resolve and unblock runs),
                                  review_model (the model of review and verify runs, default opus),
                                  reload_on_change (on|off): restart onto new daemon/src code once nothing is running,
                                  review_due_days, review_due_lines: a repo is due for an area review once its oldest
                                  refs/reviewed/* mark is older than that many days, or more lines merged since it,
                                  plan_branch_sync_minutes (default 60): how often each plan branch is synced with its base,
                                  plan_branch_max_days (default 14), plan_branch_max_lines (default 3000): a plan branch older
                                  than that, or further ahead of its base, is listed in attention`;

export const NOTIFY_HELP = `  agentdeck notify-test           send a test notification on every enabled channel`;
