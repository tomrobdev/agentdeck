# The GitHub end-to-end test

`pnpm test:github` runs the daemon through a task's whole life on a real GitHub repo: a task done and its PR opened, the PR's check run, a review run, auto-merge, a second task whose PR conflicts with main and is synced with a resolve run, then merged, and a PR a person closes. The daemon runs with the fake claude (`daemon/test/fixtures/fake-claude.mjs`), so it costs no usage, only a few GitHub Actions minutes. The script is `daemon/scripts/github-e2e.mjs`.

It is opt-in and run by a person, in a session: workers can't reach GitHub, and CI does not run it. It refuses to run without `AGENTDECK_GITHUB_E2E_REPO` and a logged-in `gh`.

## Make the throwaway repo

Once, by hand:

1. Make a new, empty repo under your account, for this test alone: `gh repo create tomrobdev/agentdeck-e2e --private`. Leave it empty, or with only the README GitHub offers; the script refuses a repo whose main has more than one commit it did not make.
2. Leave GitHub Actions on (they are, for a new repo), and add no branch protection to main: the script force-pushes it.
3. Let `gh` push a workflow: the reset writes one, and pushing it over HTTPS needs the `workflow` scope, `gh auth refresh -s workflow`. A repo cloned over SSH needs nothing more.
4. Let git push without asking: the script clones with `gh repo clone`, and the daemon pushes from that clone and never prompts for credentials. Over HTTPS, `gh auth setup-git` makes `gh` git's credential helper.

Nothing else: the script writes the repo's README and its workflow every time it runs.

## Run it

```sh
AGENTDECK_GITHUB_E2E_REPO=tomrobdev/agentdeck-e2e pnpm test:github
```

It takes a few minutes, most of it waiting for GitHub's check. `--keep` keeps the scratch home after a pass (`pnpm test:github --keep`); after a failure it is always kept, and the daemon's last lines are printed.

What it does, in order, checking GitHub with `gh` and the daemon's database after each step:

1. **Reset.** Closes the repo's open PRs from `agentdeck/` branches, deletes those branches, and force-pushes main to one commit, "agentdeck github-e2e: reset", with a README and a workflow whose one check, `check`, runs on every PR.
2. **Register.** Clones the repo into a scratch `AGENTDECK_HOME` in the temp folder, registers it with `pr_mode ready` and `auto_merge`, `auto_review` and `auto_resolve` on, and no test command, so auto-merge waits for the PR's check. The planner is off. It starts the daemon there on a free port, never the installed daemon's.
3. **Task one** is done and its PR opened, with the auto-merge label; the check passes on GitHub and the daemon keeps it; a review run reads the changes and its review is clean; the daemon merges the PR and deletes its branch.
4. **Task two** lands after task one, and both write the same new file, so once task one merges, task two's PR conflicts with main. A resolve run syncs it, the branch on GitHub gets the merge with main, and the daemon merges it with both sides kept.
5. **Task three** has auto-merge off. Once its PR is open the script closes it with `gh pr close`; the daemon records it closed, and neither merges it nor opens another.
6. **A plan branch.** A plan of three tasks, each building on the one before, gets a plan branch (`plan/<id>-…`) with `agentdeck plan-branch open`. The first task's PR opens into the plan branch, not main, and merges there with the branch kept. A commit pushed to main that conflicts with the plan branch is brought in by a resolve run. The other two tasks' PRs merge into the plan branch, the plan's PR opens into main, and the script merges it with `gh pr merge`; the daemon records the plan branch landed and deletes it on GitHub.
7. **Cleanup.** Stops the daemon and deletes the `agentdeck/` and `plan/` branches it left on GitHub, passed or not.

`pnpm test:github --record` also writes the GitHub responses of the plan branch scenario, a task PR whose base is the plan branch and the plan's PR, to `daemon/test/fixtures/gh/`, as `pr-view-plan-branch-task` and `pr-view-plan-branch`.

The PR refresh runs every few minutes; the script asks for one every few seconds instead, as a merge from the CLI does.

It exits 0 when every step passed, 1 when one failed, and 2 when it refused to run. Paste the output in the PR of a change that needs it.
