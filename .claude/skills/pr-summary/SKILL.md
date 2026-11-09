---
name: pr-summary
description: Write a pull request summary in the Overview, Frontend, Backend format AgentDeck's workers use. Use when the user asks for a PR description, a PR summary, to open a PR from this session, or to rewrite the summary of a task's PR.
---

# Write a PR summary

AgentDeck's workers end every done run with this summary, and it becomes the PR's body and the Overview's pull request card. A PR opened from a session should read the same, so a reviewer reads every PR one way. The format's one source is `PR_SUMMARY_FORMAT` in `daemon/src/domain/landing/pull-request/summary.ts` of the AgentDeck repo; if that text has changed, follow it over this page.

## The format

Bullets in these sections, in this order:

```
## Overview
## Frontend
## Backend
```

- Bullets only, one line each, at most 5 per section.
- File names in backticks.
- Never write "I".
- Leave out a section with nothing in it.
- **Overview:** what changed and why, and how it was checked. Name any test the sandbox broke, and anything not tried for real.
- **Frontend:** what the user sees, or the dashboard code.
- **Backend:** the daemon, data and everything else.

## Writing it

1. Read the whole diff against the base (`git diff origin/<base>...HEAD`), not only the last commit, and the task's prompt or plan if there is one.
2. Lead the Overview with the change a reviewer cares about most, in plain words. Say what was checked and how: the test command, a run in the app, or that it wasn't tried.
3. One bullet per change a reviewer would look at, not one per file.
4. Show it to the person before it goes on GitHub.

## Putting it on the PR

- New PR: `gh pr create --title "<title>" --body-file <file>`.
- Existing PR: `gh pr edit <url> --body-file <file>`.

A worker's PR body also has the plan's steps and a table of runs, which AgentDeck adds (`buildPrBody` in `daemon/src/domain/landing/pull-request/pr.ts`). When rewriting one, change only the summary part and keep the rest. A merge through AgentDeck builds the squash commit message again from the runs' own summaries, not from the PR's body, so an edit on GitHub changes the PR page but not the commit.
