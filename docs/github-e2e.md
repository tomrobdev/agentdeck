# The GitHub end-to-end test

`pnpm test:github` runs the daemon through a task's whole life on a real GitHub repo: a task done and its PR opened, the PR's check run, a review run, auto-merge, a second task whose PR conflicts with main and is synced with a resolve run, then merged, and a PR a person closes. The daemon runs with the fake claude (`daemon/test/fixtures/fake-claude.mjs`), so it costs no usage, only a few GitHub Actions minutes. The script is `daemon/scripts/github-e2e.mjs`.

It is opt-in and run by a person, in a session: workers can't reach GitHub, and CI does not run it. It refuses to run without `AGENTDECK_GITHUB_E2E_REPO`, `AGENTDECK_GITHUB_E2E_REPO_2` and a logged-in `gh`.

## Make the throwaway repos

Once, by hand:

1. Make two new, empty repos under your account, for this test alone: `gh repo create tomrobdev/agentdeck-e2e --private` and `gh repo create tomrobdev/agentdeck-e2e-2 --private`. Leave them empty, or with only the README GitHub offers; the script refuses a repo whose base (`main` in the first, `develop` in the second) has more than one commit it did not make.
2. Leave GitHub Actions on (they are, for a new repo), and add no branch protection to main: the script force-pushes it.
3. Let `gh` push a workflow: the reset writes one, and pushing it over HTTPS needs the `workflow` scope, `gh auth refresh -s workflow`. A repo cloned over SSH needs nothing more.
4. Let git push without asking: the script clones with `gh repo clone`, and the daemon pushes from that clone and never prompts for credentials. Over HTTPS, `gh auth setup-git` makes `gh` git's credential helper.

Nothing else: the script writes the repo's README and its workflow every time it runs.

## Run it

```sh
AGENTDECK_GITHUB_E2E_REPO=tomrobdev/agentdeck-e2e AGENTDECK_GITHUB_E2E_REPO_2=tomrobdev/agentdeck-e2e-2 pnpm test:github
```

It takes a few minutes, most of it waiting for GitHub's check. `--keep` keeps the scratch home after a pass (`pnpm test:github --keep`); after a failure it is always kept, and the daemon's last lines are printed.

What it does, in order, checking GitHub with `gh` and the daemon's database after each step:

1. **Reset.** In each repo, closes the open PRs from `agentdeck/` and `plan/` branches, deletes those branches, and force-pushes the base (`main`, and `develop` in the second) to one commit, "agentdeck github-e2e: reset", with a README and a workflow whose one check, `check`, runs on every PR.
2. **Register.** Clones the repo into a scratch `AGENTDECK_HOME` in the temp folder, registers it with `pr_mode ready` and `auto_merge`, `auto_review` and `auto_resolve` on, and no test command, so auto-merge waits for the PR's check. The planner is off. It starts the daemon there on a free port, never the installed daemon's.
3. **Task one** is done and its PR opened, with the auto-merge label; the check passes on GitHub and the daemon keeps it; a review run reads the changes and its review is clean; the daemon merges the PR and deletes its branch.
4. **Task two** lands after task one, and both write the same new file, so once task one merges, task two's PR conflicts with main. A resolve run syncs it, the branch on GitHub gets the merge with main, and the daemon merges it with both sides kept.
5. **Task three** has auto-merge off. Once its PR is open the script closes it with `gh pr close`; the daemon records it closed, and neither merges it nor opens another.
6. **A plan branch.** A plan of three tasks, each building on the one before, gets a plan branch (`plan/<id>-…`) with `agentdeck plan-branch open`. The first task's PR opens into the plan branch, not main, and merges there with the branch kept. A commit pushed to main that conflicts with the plan branch is brought in by a resolve run. The other two tasks' PRs merge into the plan branch, the plan's PR opens into main, and the script merges it with `gh pr merge`; the daemon records the plan branch landed and deletes it on GitHub.
7. **A plan across repos, landed in order.** The second repo is registered as `e2e2` with base `develop` and squash merges, and the first switches to merge commits. A plan with a task in each gets a plan branch in each, and `agentdeck plan-branch policy <plan> in_order e2e2,e2e`. Once both tasks have merged into their plan branches and the plan PRs are open, the daemon merges `e2e2`'s plan PR into `develop` first and `e2e`'s into `main` after it, each by its repo's method (a squash commit with one parent, a merge commit with two), and records both plan branches landed.
8. **Cleanup.** Stops the daemon and deletes the `agentdeck/` and `plan/` branches it left on both repos, passed or not.

`pnpm test:github --record` also writes the GitHub responses of the plan branch scenario, a task PR whose base is the plan branch and the plan's PR, to `daemon/test/fixtures/gh/`, as `pr-view-plan-branch-task` and `pr-view-plan-branch`.

The PR refresh runs every few minutes; the script asks for one every few seconds instead, as a merge from the CLI does.

It exits 0 when every step passed, 1 when one failed, and 2 when it refused to run. Paste the output in the PR of a change that needs it.

## Try a parent issue as a plan by hand

The script does not cover issue-backed repos; try one on a throwaway repo, with a daemon on a scratch home as above:

1. `agentdeck repo set <repo> issues on` (and `pr_mode ready`), then make a parent issue and two sub-issues: `gh issue create --title "Phase 1" --body $'Why.\n\n## First\n\n## Second'`, then `gh issue create … --label ready-for-agent` twice, and add each as a sub-issue of the parent on GitHub.
2. Label the parent: `gh issue edit <parent> --add-label agentdeck:plan`. Within one poll (two minutes) the parent gets an "Opened as AgentDeck plan #n" comment, `agentdeck ls --status parked` shows the plan's task, and both sub-issues' tasks target `plan/<n>-phase-1` (`agentdeck show <task>`). The repo's base is unchanged.
3. The sub-issues' PRs open into the plan branch; merge them, and each sub-issue closes. The plan PR opens into the base and the parent hears about it; once it merges (by a person, or by its landing policy) the parent closes as completed with a link to it.
4. To check the abandon: on a fresh parent, take `agentdeck:plan` off before any of its tasks starts; the plan branch is abandoned and the sub-issues' tasks go back to the base.
