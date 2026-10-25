export const HELP = `agentdeck: always-on Claude Code task queue

Repos
  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--setup "npm ci"] [--tools "Read,Edit,Bash(npm *)"]
                                                  the toolchain is detected; flags override what it suggests
  agentdeck repo ls [--archived]                  list repos (only the archived ones with --archived)
  agentdeck repo archive <repo>                   hide the repo and its tasks and stop its work; refuses while a task runs
  agentdeck repo unarchive <repo>                 bring an archived repo and its tasks back as they were
  agentdeck repo doctor <repo>                    check the repo is ready for unattended runs; pauses it if not (exit 1)
  agentdeck repo resume <repo>                    let a paused repo's tasks run again
  agentdeck repo set <repo> auto_approve on|off   planner tasks skip approval
  agentdeck repo set <repo> base_branch <branch>  branch new task worktrees start from
  agentdeck repo set <repo> test_cmd "<cmd>"      run after each task ("" for none)
  agentdeck repo set <repo> setup_cmd "<cmd>"     run in each worktree before claude ("" for none)
  agentdeck repo set <repo> pr_mode off|draft|ready  push and open a PR when a task is done
  agentdeck repo set <repo> merge_method squash|merge|rebase  how the app and \`agentdeck merge\` merge a PR (default squash)
  agentdeck repo set <repo> auto_resolve on|off   start a conflict run on its own when a branch conflicts with the base (default on)
  agentdeck repo set <repo> sandbox on|off        run the agent's shell commands in Claude Code's sandbox (default on)
  agentdeck repo set <repo> network "<hosts>"     hosts sandboxed commands may reach, e.g. "registry.npmjs.org,github.com" ("" for none)
  agentdeck goals <repo> [--file goals.md]        show (or replace) the goals the planner works from
  agentdeck plan <repo>                           run the planner now

Tasks
  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model sonnet] [--max-turns n] [--attempts n]
                      [--after <task>]          wait until that task is done (and its PR merged, if it has one)
                      [--plan <path>] [--steps a,b]   carry out steps of a plan on the base branch (docs/plans/x.html);
                                                      without --steps, every step not yet done
  agentdeck edit <id> [--title t] [--prompt p] [--priority n] [--model m] [--max-turns n] [--attempts n]
                      [--plan <path>] [--steps a,b]   change the plan link ("" clears it)
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
  agentdeck retry <id> [--note "…"]   another attempt; the note goes first in its prompt (changes requested in review)
  agentdeck close-pr <id>       close the task's open pull request without merging
  agentdeck merge <id> [--method squash|merge|rebase] [--yes] [--keep-branch]
                                  merge a done task's open PR: shows the preview, asks unless --yes, then deletes
                                  the remote branch and the worktree unless --keep-branch
  agentdeck resolve <id>      merge the base branch into a done task's branch (the PR gets the push); conflicts start
                                  a claude run, and if it fails the merge is undone and the task is blocked
  agentdeck clean <id>          remove the task's worktree (its branch is kept)

Daemon
  agentdeck install             run the daemon at login via launchd (restarted if it dies)
  agentdeck uninstall
  agentdeck service [start|stop]  launchd status; start or stop the service, keeping its plist
  agentdeck restart [--now]     restart the service: pause new claims, wait until no task or planner run is active,
                                  restart, restore the pause state. --now restarts at once (a running task is requeued)
  agentdeck logs [-f] [-n lines]  print (or follow) ~/.agentdeck/logs/daemon.log
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            work the queue until empty, then exit (ignores pause)
  agentdeck pause | resume
  agentdeck status
  agentdeck settings              show concurrency, usage budget and notification settings
  agentdeck set <key> <value>     max_concurrent, five_hour_max, five_hour_soft, weekly_max, pace_slack (0..1),
                                  notify_desktop (on|off), notify_events (done,blocked,failed,hold,proposed), ntfy_topic, ntfy_server,
                                  planner_enabled (on|off), planner_interval_hours, planner_max_tasks, planner_model,
                                  reload_on_change (on|off): restart onto new daemon/src code once nothing is running
  agentdeck notify-test           send a test notification on every enabled channel
`;
