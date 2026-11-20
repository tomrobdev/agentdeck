// The help lines of the task and plan branch commands.
import { MODELS } from '#domain/work/index.ts';

export const WORK_HELP = `  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model ${MODELS.join('|')}] [--max-turns n] [--attempts n]
                      without --model: the repo's model, else the default_model setting
                      [--target <branch>]       start from and land on that branch (local or on origin), not the base
                      [--builds-on <tasks>]     start once those tasks (12,14) are done and merged
                                                where this task's target gets them, in any repo
                                                (refused when their work never reaches its target)
                      [--after <tasks>]         run at once; the PR waits to merge until those tasks have landed
                      [--plan <file|task>] [--steps a,b]   carry out steps of a plan: a plan file anywhere on disk
                                                      (stored as this task's plan) or a task number (follow that
                                                      task's plan, any repo); without --steps, every step not yet done
                      [--propose]               file it as a proposal that waits for \`agentdeck approve\`, like the planner's
  agentdeck edit <id> [--title t] [--prompt p] [--priority n] [--model m] [--max-turns n] [--attempts n]
                      [--plan <file|task>] [--steps a,b]   change the plan link ("" clears it)
                      [--target <branch>]       change the target ("" is the base); refused once the task has a branch
                                  for proposed, parked, queued, blocked or failed tasks
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
  agentdeck plan-branch open <plan task>   open a plan branch, plan/<id>-<slug>, in each repo the plan's tasks are in
                                  (run it again for a repo a later task brings): the tasks there that haven't started,
                                  and tasks added later with --plan, target it; the daemon cuts it from that repo's base
                                  and pushes it when the first of them starts
  agentdeck plan-branch abandon <plan task>   close them all: their tasks that haven't started move back to the base;
                                  refused while one runs
  agentdeck plan-branch policy <plan task> person|auto|together|in_order [repo,repo,...]   how the plan PRs land:
                                  a person merges each (person, the default), the daemon merges each once its check
                                  passes (auto), none until all are ready (together), or one repo at a time in the order given
  agentdeck plan-branch question <plan task>   what a plan that landed in only some repos asks
  agentdeck plan-branch answer <plan task> retry|revert|by_hand   answer it: merge again, open revert PRs for the
                                  landed repos and abandon the rest, or finish by hand
  agentdeck approve <id>...       queue planner proposals
  agentdeck reject <id>...
  agentdeck park <id>... [--reason "…"]   keep proposals for later: off Attention, not approvable, not counted as
                                  open work by the planner; list them with \`agentdeck ls --status parked\`
  agentdeck lift <id>...          bring parked tasks back to proposed
  agentdeck cancel <id>
  agentdeck retry <id> [--note "…"] [--model <model>] [--max-turns n]   another attempt; the note goes first in its prompt (changes
                                  requested in review). It runs on --model and --max-turns if given; without --model, a blocked or failed task whose
                                  last run hit the turn limit, failing tests, an error or no change runs one model up (repo escalate)
  agentdeck done <id> [--note "…"]   mark a blocked or failed task done (you finished the work); tasks waiting on it start
  agentdeck install-needs <id> [--yes]   install the packages a blocked task asked for (NEEDS deps) on its branch, then retry`;
