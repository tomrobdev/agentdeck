import { NOTIFY_KINDS } from '../domain/operations/index.ts';
import { DEFAULT_AUTO_MERGE_MAX_LINES, DEFAULT_AUTO_MERGE_SKIP, PR_OPEN_RETRIES } from '../domain/landing/index.ts';
import { MODELS } from '../domain/work/index.ts';

export const HELP = `agentdeck: always-on Claude Code task queue

Repos
  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--setup "npm ci"] [--tools "Read,Edit,Bash(npm *)"]
                                                  the toolchain is detected; flags override what it suggests
  agentdeck repo ls [--archived]                  list repos (only the archived ones with --archived)
  agentdeck repo archive <repo>                   hide the repo and its tasks and stop its work; refuses while a task runs
  agentdeck repo unarchive <repo>                 bring an archived repo and its tasks back as they were
  agentdeck repo delete <repo> [--yes]            delete an archived repo, its tasks, runs, worktrees and logs for good (local only); asks unless --yes
  agentdeck repo doctor <repo>                    check the repo is ready for unattended runs; pauses it if not (exit 1)
  agentdeck repo resume <repo>                    let a paused repo's tasks run again
  agentdeck repo set <repo> auto_approve on|off   planner tasks skip approval
  agentdeck repo set <repo> base_branch <branch>  branch new task worktrees start from
  agentdeck repo set <repo> test_cmd "<cmd>"      run after each task ("" for none)
  agentdeck repo set <repo> setup_cmd "<cmd>"     run in each worktree before claude ("" for none)
  agentdeck repo set <repo> pr_mode off|draft|ready  push and open a PR when a task is done
  agentdeck repo set <repo> merge_method squash|merge|rebase  how the app and \`agentdeck merge\` merge a PR (default squash)
  agentdeck repo set <repo> auto_resolve on|off   start a resolve run on its own when a branch conflicts with the base (default on)
  agentdeck repo set <repo> auto_unblock on|off   start a short unblock run on its own when a task blocks: it retries the task
                                                  with a note or leaves it blocked with a question; uses no attempt (default off)
  agentdeck repo set <repo> auto_review on|off    start a review run on its own when a task is done: it reads the changes
                                                  against the task's goal and plan steps; uses no attempt (default off)
  agentdeck repo set <repo> auto_merge on|off     merge a done task's PR on its own once checks and tests pass (default off;
                                                  planner proposals only when auto_approve is off)
  agentdeck repo set <repo> auto_merge_max_lines <n>  a PR changing more lines needs a person (default ${DEFAULT_AUTO_MERGE_MAX_LINES})
  agentdeck repo set <repo> auto_merge_skip "<prefixes>"  a PR touching these paths needs a person (default "${DEFAULT_AUTO_MERGE_SKIP.join(',')}")
  agentdeck repo set <repo> sandbox on|off        run the agent's shell commands in Claude Code's sandbox (default on)
  agentdeck repo set <repo> network "<hosts>"     hosts sandboxed commands may reach, e.g. "registry.npmjs.org,github.com" ("" for none)
  agentdeck repo set <repo> model ${MODELS.join('|')}|""  the model a new task of the repo takes when it names none
                                                  ("" follows the default_model setting)
  agentdeck repo set <repo> tools "<rules>"       replace the tool rules workers run with, comma-separated, e.g. "Read,Edit,Bash(make *)"
                                                  ("" goes back to the defaults plus the rules detected from its toolchain)
  agentdeck goals <repo> [--file goals.md]        show (or replace) the goals the planner works from
  agentdeck propose <repo>                        run the planner now (also: repo propose, plan)

Tasks
  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model ${MODELS.join('|')}] [--max-turns n] [--attempts n]
                      without --model: the repo's model, else the default_model setting
                      [--builds-on <tasks>]     start once those tasks (12,14) are done and merged
                      [--after <tasks>]         run at once; the PR waits to merge until those tasks have landed
                      [--plan <file|task>] [--steps a,b]   carry out steps of a plan: a plan file anywhere on disk
                                                      (stored as this task's plan) or a task number (follow that
                                                      task's plan, same repo); without --steps, every step not yet done
                      [--propose]               file it as a proposal that waits for \`agentdeck approve\`, like the planner's
  agentdeck edit <id> [--title t] [--prompt p] [--priority n] [--model m] [--max-turns n] [--attempts n]
                      [--plan <file|task>] [--steps a,b]   change the plan link ("" clears it)
                                  for proposed, queued, blocked or failed tasks
  agentdeck link <id> --builds-on <task>   or --after <task>: make a task depend on another (cycles are refused)
  agentdeck unlink <id> <task>    remove that link
  agentdeck ls [<search>] [--status s,…] [--repo r] [--sort attention|updated|newest|oldest|priority]
                                  search matches #id, title, branch, model or reason; --status takes statuses,
                                  states (waiting, stuck, review, merged, pr-closed, no-pr) or groups (active, needs-you)
  agentdeck show <id>
  agentdeck review <id>       list the task's reviews (made in the dashboard) and their comments
  agentdeck log <id> [--attempt n] [--raw]
  agentdeck attach <id> <plan.html>   store or replace the task's own plan (docs/plan-format.md), named
                                  <id>-<slug>.html after the task and the plan's title
  agentdeck approve <id>...       queue planner proposals
  agentdeck reject <id>...
  agentdeck cancel <id>
  agentdeck retry <id> [--note "…"]   another attempt; the note goes first in its prompt (changes requested in review)
  agentdeck done <id> [--note "…"]   mark a blocked or failed task done (you finished the work); tasks waiting on it start
  agentdeck install-needs <id> [--yes]   install the packages a blocked task asked for (NEEDS deps) on its branch, then retry
  agentdeck fix-checks <id>    retry a done task whose PR checks fail, with each failing check and its log tail in the note
  agentdeck open-pr <id>       push a done task's branch and open its pull request: one that failed to open (the PR
                                  refresh tries ${PR_OPEN_RETRIES} more times, then it needs you), never opened, or was closed
  agentdeck close-pr <id>      close the task's open pull request without merging
  agentdeck merge <id> [--method squash|merge|rebase] [--yes] [--keep-branch]
                                  merge a done task's open PR: shows the preview, asks unless --yes, then deletes
                                  the remote branch and the worktree unless --keep-branch
  agentdeck merge --all [--yes]   ask the daemon to merge every PR in review once it is ready, as the app's Merge all:
                                  each with its repo's method, deleting the branches; leaves one with failing checks,
                                  failed tests or blocked by GitHub, and says why (also when the daemon is not running)
  agentdeck auto-merge <id> on|off|repo   let the daemon merge this task's PR on its own, or not, or follow the repo
  agentdeck sync <id>         sync a done task's branch with the base branch (the PR gets the push); conflicts start
                                  a claude run, and if it fails the merge is undone and the task is blocked (also: resolve)
  agentdeck clean <id>          remove the task's worktree (its branch is kept)
  agentdeck context [--repo r] [--since <event>]   the repo's live queue in a few lines, for an agent (default: this
                                  directory's repo); --since shows what changed after that event. --hook is the
                                  mode Claude Code's SessionStart and UserPromptSubmit hooks run (hook JSON on stdin)

Daemon
  agentdeck install             run the daemon at login via launchd (restarted if it dies)
  agentdeck uninstall
  agentdeck service [start|stop]  launchd status; start or stop the service, keeping its plist
  agentdeck restart [--now]     restart the service: pause new claims, wait until no task or planner run is active,
                                  restart, restore the pause state. --now restarts at once (a running task is requeued)
  agentdeck logs [-f] [-n lines]  print (or follow) ~/.agentdeck/logs/daemon.log
  agentdeck doctor [--json]     check the daemon: service, API, loaded commit, reload, stray claude processes, the log, gh,
                                  area reviews due (a warning, never a failure); each failed check names the command that
                                  fixes it (exit 1 if any fails; works with the daemon down)
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            work the queue until empty, then exit (ignores pause; refused while the daemon runs)
  agentdeck pause | resume
  agentdeck status
  agentdeck settings              show concurrency, usage budget and notification settings
  agentdeck set <key> <value>     max_concurrent, five_hour_max, five_hour_soft, weekly_max, pace_slack (0..1),
                                  notify_desktop (on|off), notify_events (${NOTIFY_KINDS.join(',')}), ntfy_topic, ntfy_server,
                                  planner_enabled (on|off), planner_interval_hours, planner_max_tasks, planner_model,
                                  default_model (a new task's model when neither it nor its repo names one),
                                  support_model (the model of resolve and unblock runs),
                                  review_model (the model of review runs, default opus),
                                  reload_on_change (on|off): restart onto new daemon/src code once nothing is running,
                                  review_due_days, review_due_lines: a repo is due for an area review once its oldest
                                  refs/reviewed/* mark is older than that many days, or more lines merged since it
  agentdeck stats [--repo r] [--since <date>] [--by week|model] [--json]  the pilot scorecard measures per repo: tasks done on
                                  the first run (with a Wilson 95% interval), permission denials per run, cost and minutes per
                                  done task, then interventions, median minutes queued, running and in review, PRs green on CI
                                  when opened and quota spent (points of the 7-day window); --by week adds a row per week,
                                  --by model a row per model the work runs ran on (runs from before models were recorded: unknown)
  agentdeck notify-test           send a test notification on every enabled channel
`;
