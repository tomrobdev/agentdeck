import {
  DEFAULT_AUTO_MERGE_MAX_LINES,
  DEFAULT_AUTO_MERGE_SKIP,
  DEFAULT_CODE_COMMENT_MAX_LINES,
  DEFAULT_CODE_COMMENT_MAX_PERCENT,
} from '#domain/landing/index.ts';
import { MODELS } from '#domain/work/index.ts';

export const REPOS_HELP = `  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--setup "npm ci"] [--tools "Read,Edit,Bash(npm *)"]
                                                  the toolchain is detected; flags override what it suggests
  agentdeck repo ls [--archived]                  list repos (only the archived ones with --archived)
  agentdeck repo archive <repo>                   hide the repo and its tasks and stop its work; refuses while a task runs
  agentdeck repo unarchive <repo>                 bring an archived repo and its tasks back as they were
  agentdeck repo delete <repo> [--yes]            delete an archived repo, its tasks, runs, worktrees and logs for good (local only); asks unless --yes
  agentdeck repo doctor <repo>                    check the repo is ready for unattended runs; pauses it if not (exit 1)
  agentdeck repo resume <repo>                    let a paused repo's tasks run again (or end its drain)
  agentdeck repo drain <repo>                     start none of its new tasks, finish its work in flight, then pause it
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
  agentdeck repo set <repo> issues on|off         take tasks from GitHub Issues labelled ready-for-agent and report back on them;
                                                  \`agentdeck add\` is refused while it is on (default off); a parent issue
                                                  labelled agentdeck:plan becomes a plan whose sub-issues land on one plan branch
  agentdeck repo set <repo> issues_allow "<logins>"  GitHub logins whose label starts a task ("" = the login gh is signed in as)
  agentdeck repo set <repo> escalate on|off       a retry after the turn limit, failing tests, an error or no change runs one
                                                  model up: haiku to sonnet, sonnet to opus (default on)
  agentdeck repo set <repo> auto_merge on|off     merge a done task's PR on its own once checks and tests pass (default off;
                                                  planner proposals only when auto_approve is off)
  agentdeck repo set <repo> auto_merge_max_lines <n>  a PR changing more lines needs a person (default ${DEFAULT_AUTO_MERGE_MAX_LINES})
  agentdeck repo set <repo> auto_merge_skip "<prefixes>"  a PR touching these paths needs a person (default "${DEFAULT_AUTO_MERGE_SKIP.join(',')}")
  agentdeck repo set <repo> ci_not_run_ok on|off  a GitHub check that never started (a billing stop, a spending limit) doesn't
                                                  stop auto-merge when the last run passed the tests (default off)
  agentdeck repo set <repo> code_comment_max_lines <n>  a branch adding more code comment lines is over the limit
                                                  (0 to 10000, 0 turns it off; default ${DEFAULT_CODE_COMMENT_MAX_LINES})
  agentdeck repo set <repo> code_comment_max_percent <n>  a branch whose added lines are a greater share of code comments
                                                  is over the limit (0 to 100, 0 turns it off; default ${DEFAULT_CODE_COMMENT_MAX_PERCENT})
  agentdeck repo set <repo> union_paths "<globs>"  files whose conflicts in a sync keep both sides' lines, e.g. "docs/review-areas.md"
                                                  ("" for none)
  agentdeck repo set <repo> generated_paths "<globs>"  files generated_cmd rebuilds: a sync conflicting only in them reruns
                                                  the command instead of a resolve run, e.g. "docs/reference/**" ("" for none)
  agentdeck repo set <repo> generated_cmd "<cmd>"  the command that rebuilds generated_paths, e.g. "pnpm docs:gen" ("" for none)
  agentdeck repo set <repo> max_concurrent <n>    how many of its tasks may run at once, under the daemon's max_concurrent
                                                  (1 to 8; default 1)
  agentdeck repo set <repo> sandbox on|off    run the agent's shell commands in Claude Code's sandbox (default on)
  agentdeck repo set <repo> network "<hosts>"     hosts sandboxed commands may reach, e.g. "registry.npmjs.org,github.com" ("" for none)
  agentdeck repo set <repo> model ${MODELS.join('|')}|""  the model a new task of the repo takes when it names none
                                                  ("" follows the default_model setting)
  agentdeck repo set <repo> tools "<rules>"       replace the tool rules workers run with, comma-separated, e.g. "Read,Edit,Bash(make *)"
                                                  ("" goes back to the defaults plus the rules detected from its toolchain)
  agentdeck goals <repo> [--file goals.md]        show (or replace) the goals the planner works from
  agentdeck propose <repo>                        run the planner now (also: repo propose, plan)`;
