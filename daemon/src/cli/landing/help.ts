// The help lines of the commands that land a task: checks, pull requests, merging, sync and verify.
import { PR_OPEN_RETRIES } from '#domain/landing/index.ts';

export const LANDING_HELP = `  agentdeck fix-checks <id>    retry a done task whose PR checks fail, with each failing check and its log tail in the note
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
  agentdeck verify <id>       start a verify run on a proposed or queued task: a short read-only claude run that checks
                                  each claim its prompt makes about the code against the base, and prints its findings
                                  (true, false, stale or partly, with the file and line); uses no attempt`;
