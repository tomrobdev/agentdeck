---
name: review-area
description: Review one area of a repo (plan, task, run, sync, …) across every PR merged into it since it was last reviewed, with /code-review and /ponytail-review, and turn the findings into tasks. Use when the user says review an area, area review, review the plan code, what merged into X, or wants AgentDeck's PRs reviewed in batches instead of one by one.
---

# Review an area

Workers merge faster than a person can review each PR. So review one area at a time: its code as it is now, and everything merged into it since its last review. That also catches what per-PR reviews can't see: two tasks adding the same helper, names drifting from the repo's domain language, a feature split across PRs that doesn't add up.

This doesn't replace a person on risky PRs: the repo's `auto_merge_skip` still holds those for review before they merge.

## 1. Pick the area

Areas are in the repo's `docs/review-areas.md` (AgentDeck's own), or else `areas/<repo>.md` next to this file: a heading per area and the path prefixes it covers. Keep them in the repo, outside `.claude/`, so workers can map the files they add and their PRs still auto-merge. No file for the repo yet: propose areas from its CLAUDE.md and architecture docs (slices down through the layers, one per aggregate or feature, not one per layer), agree them with the person, and write `docs/review-areas.md`.

Check the map is current before measuring anything. In AgentDeck, `node --test daemon/test/architecture/review-areas.test.ts` fails on a listed path that no longer exists and on a source file in no area; `pnpm check` runs it on every PR, so it only fails here when main is red. In another repo, check by hand that each listed path exists and that new folders have an area.

First bring the checkout up to date with `git pull --ff-only`, not only `git fetch`: reviewers read callers from the checkout, and a checkout behind `origin/main` gives them stale files (in the run review, it was missing a task that had just merged). An area's last review is a local ref, `refs/reviewed/<area>`. Show each area's change since then:

```sh
git diff --shortstat refs/reviewed/<area> origin/main -- <paths…>
```

An area with no ref has never been reviewed: ask where to start, by default a week back (`git rev-list -1 --before='7 days ago' origin/main`). Show the areas with the most change and let the person pick one.

## 2. Gather what merged

- **Tasks:** AgentDeck's merge commits end with `Made by AgentDeck task #<id>`. `git log --format=%B <from>..origin/main -- <paths…> | grep -o 'task #[0-9]*'` lists them; `agentdeck show <id>` gives each one's Goal, Definition of done and plan. Commits with no task came from sessions: list them too.
- **The review branch:** one commit holding the area's changes and nothing else:

  ```sh
  ~/.claude/skills/review-area/area-branch.sh <area> <from> origin/main <paths…>
  ```

  Write the paths out as separate words: zsh doesn't split a variable holding them. It makes the local branch `area-review/<area>`, one commit on top of `<from>`. Its change is the three-dot diff, `git diff main...area-review/<area>` (or `<from>..area-review/<area>`): exactly the area's change. A two-dot diff against main shows every file that changed elsewhere since `<from>`, so pass reviewers the three-dot form. The checkout's files are current, so reviewers read real callers. Never push it.

## 3. Review it three ways

Start two subagents at once, each given the branch, the three-dot diff command, the tasks' goals and the expected load, and each told to cite line numbers from the files on main, to change no files, and to return its report in full:

- **Correctness:** `/code-review high area-review/<area>`.
- **Senior-dev review:** `/ponytail-review` of `area-review/<area>` against main: bugs, load, risky code without a test, what to cut. Subagents may not have the plugin's skills (it said "Unknown skill" in the first run), so tell the subagent to follow `~/.claude/plugins/marketplaces/ponytail/skills/ponytail-review/SKILL.md` by hand when the skill can't be invoked.

Check the reports' line numbers before using them: a reviewer can cite lines past the end of a file.

While they run, do the area pass yourself, which neither does. Read the area's files whole, not only the diff, and look for:

- **Domain language:** every new name, log line and UI string against the repo's terms (CLAUDE.md's Domain language, or a GLOSSARY.md). A new word for an existing thing gets renamed; a new concept with no term is a question for the person, and its term goes in the glossary once settled (`domain-modeling`).
- **Decisions in the right layer:** a rule about business state (a status check, a limit, a choice between outcomes) written in `application/`, `api/` or `cli/` that belongs in `domain/`. Imports can be clean while the logic sits in the wrong place.
- **Aggregate edges:** one aggregate deciding another's state, or reaching into its internals instead of asking it.
- **Rules no test checks:** skip the ones `pnpm check` enforces. In AgentDeck the unchecked ones are listed with their reasons in `daemon/scripts/lib/rules.ts` (`pnpm rules`); check the area's files against those. Check the ADRs in `docs/adr/` when the area touches them.
- **Across tasks:** the same job done twice, code a later task left dead when it replaced an earlier one's, and a task's goal or Definition of done the merged code doesn't meet.
- **Shallow modules:** wrappers and pass-throughs that add an interface without hiding anything. Name them; a bigger restructure goes to `improve-codebase-architecture`, not into a fix task.

## 4. Report

One list from the three: drop duplicates, and drop anything you can't back with a concrete case after re-reading the code. Open with two lines on the area's shape now. Number the findings, most severe first, each with `path:line`, the task that brought it in (`#id`, or "session"), and the fix. Name changes outside every area as unmapped.

## 5. Act on the person's OK

- Group findings into fix tasks, one per PR's worth, written with `add-task`'s sections; queue them, or `--propose` them to triage later.
- A one-line fix the person wants now: make it in this session.
- A rule finding that could be checked mechanically, or one seen in an earlier area review too: propose a test for it in `daemon/test/architecture/architecture.test.ts` (or move it off the unchecked list), so `pnpm check` catches it on every PR from then on.
- Then mark the area reviewed and remove the branch:

  ```sh
  git update-ref refs/reviewed/<area> <the origin/main commit you reviewed>
  git branch -D area-review/<area>
  ```

Move the ref even while findings are open: they live on as tasks, and the next review starts from here.
