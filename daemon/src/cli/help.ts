export const HELP = `agentdeck: always-on Claude Code task queue

Repos
  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--setup "npm ci"] [--tools "Read,Edit,Bash(npm *)"]
                                                  the toolchain is detected; flags override what it suggests
  agentdeck repo ls
  agentdeck repo doctor <repo>                    check the repo is ready for unattended runs; pauses it if not (exit 1)
  agentdeck repo resume <repo>                    let a paused repo's tasks run again
  agentdeck repo set <repo> auto_approve on|off   planner tasks skip approval
  agentdeck repo set <repo> base_branch <branch>  branch new task worktrees start from
  agentdeck repo set <repo> test_cmd "<cmd>"      run after each task ("" for none)
  agentdeck repo set <repo> setup_cmd "<cmd>"     run in each worktree before claude ("" for none)
  agentdeck repo set <repo> pr_mode off|draft|ready  push and open a PR when a task is done
  agentdeck goals <repo> [--file goals.md]        show (or replace) the goals the planner works from
  agentdeck plan <repo>                           run the planner now

Tasks
  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model sonnet] [--max-turns n] [--attempts n]
                      [--after <task>]          wait until that task is done (and its PR merged, if it has one)
  agentdeck edit <id> [--title t] [--prompt p] [--priority n] [--model m] [--max-turns n] [--attempts n]
                                  for proposed, queued, blocked or failed tasks
  agentdeck ls [<search>] [--status s,…] [--repo r] [--sort attention|updated|newest|oldest|priority]
                                  search matches #id, title, branch, model or reason; --status takes statuses,
                                  states (waiting, stuck, review, merged, pr-closed, no-pr) or groups (active, needs-you)
  agentdeck show <id>
  agentdeck log <id> [--attempt n] [--raw]
  agentdeck attach <id> [plan.html]   attach a plan (docs/plan-format.md) to a task; with no file,
                                  re-read the plans under docs/plans/ on the task's branch
  agentdeck approve <id>...       queue planner proposals
  agentdeck reject <id>...
  agentdeck cancel <id>
  agentdeck retry <id>
  agentdeck clean <id>          remove the task's worktree (its branch is kept)

Daemon
  agentdeck install             run the daemon at login via launchd (restarted if it dies)
  agentdeck uninstall
  agentdeck service             launchd status
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            work the queue until empty, then exit (ignores pause)
  agentdeck pause | resume
  agentdeck status
  agentdeck settings              show concurrency, usage budget and notification settings
  agentdeck set <key> <value>     max_concurrent, five_hour_max, five_hour_soft, weekly_max, pace_slack (0..1),
                                  notify_desktop (on|off), notify_events (done,blocked,failed,hold,proposed), ntfy_topic, ntfy_server,
                                  planner_enabled (on|off), planner_interval_hours, planner_max_tasks, planner_model
  agentdeck notify-test           send a test notification on every enabled channel
`;
