# Glossary

The words AgentDeck uses in code, logs and UI. Each entry is `**Term**:` and what it means, with an optional `_Avoid_:` line of words to use nowhere in `daemon/src` or `app/src` (`daemon/test/vocabulary.test.ts` checks it). It says what things are, not how they are built.

## Work

**Repo**: a registered git repo with a base branch, a test command and goals.

**Task**: one unit of work on a repo. It moves through statuses: `proposed → queued → running → done | blocked | failed | cancelled`. A cancel during a run goes through `cancel_requested`.
_Avoid_: ticket, tickets, job, jobs

**Stop reason**: why a task ended blocked or failed, in a line.

**Stage**: where a task stands for a person, worked out from its status, its pull request and what it waits for. Not its status.

**Link**: one task depending on another, of one of two kinds. **Builds on**: B uses A's code, so B starts once A is done and merged, and B's branch includes A's work; if A is rejected, B is stuck. **After**: B only has to land after A, so B runs any time on its own branch from the base, and only its merge waits for A's. A task's links are its **dependencies**; the tasks linked to it are its **dependents**. Not a task's **Needs**, which are what a blocked worker asked for.

**Wait**: a task or a merge held back until something else happens, such as a link's task landing or checks finishing. A wait is not a hold, and not a pause.

**Plan**: an HTML page attached to a task that says how it will be done, step by step. Not the planner's proposals. Plans live in AgentDeck, not in the repo, and are never committed: a plan belongs to the task it was first attached to.

**Worktree**: the separate checkout of the repo where one task's work happens, on its own branch.

## Runs

**Run**: one attempt at a task, one `claude` process. A task has at most `max_attempts` runs, and a retry continues on the same branch. A **resolve run** is another kind: the `claude` part of a sync, settling its conflicts. It uses no attempt. An **unblock run** is the third: in a repo with `auto_unblock` on, a short run that reads why a task blocked and either retries it with a note or leaves it blocked with a **question** and options. It uses no attempt, takes a slot, and is not a resolve run.

**Review run**: a run that reads a done task's changes against its Goal, Definition of done and linked plan steps, and leaves a review of its own: a summary and findings, each blocking or not. Its **verdict** is clean when no finding blocks. It uses no attempt, takes the **review model** (a setting), and a repo starts one on its own only with `auto_review` on. It never takes or fills a person's draft.

**Model**: the Claude model a run is started with, recorded on the run. A work run takes its task's model, a resolve or unblock run the **support model** (a setting), a review run the **review model** (a setting). A new task that names none takes its repo's model, else the **default model** (a setting).

**Slot**: room for one running task.

**Sync**: bringing the base branch into a task's branch: before every run, and for a done task when its pull request conflicts or a person asks. A clean merge needs no `claude`; conflicts start a resolve run. A **conflict** is a sync that could not be settled: the merge is undone and the task is blocked.
_Avoid_: bring in

**Settle**: the daemon ending a run or a wait on its own, and doing what follows: opening the pull request, telling a person, warning the tasks that now cannot start.

**Follow-up**: what the daemon does after a task's status changes, such as opening its pull request, warning the tasks that now cannot start, or telling a person. Each status change is a domain event, and one table says what follows each.

**Protected edit**: a change to a file a worker may not edit itself. The worker proposes it, the daemon commits it after the run, and a person reviews it before it merges.

## Landing

**Merge request**: a person's merge, which the daemon carries out once the pull request is ready.

**Auto-merge check**: the daemon's judgement of whether a done task's pull request may merge without a person, and if not, what it is waiting for.

**Review**: a read of a task's changes, by a person or a review run, with line comments that go back to the worker as a note. A submitted review records the head it read and the patch-id of the task's changes against the base, so a sync that only brings in the base needs no new review.

## Capacity

**Governor**: decides whether new work may start, from the 5-hour and 7-day **usage windows**.

**Hold**: a governor decision to wait, and only that.

**Pause**: a repo or the daemon told by a person not to start work.
_Avoid_: hold, holds, holding, held

## Proposals

**Planner**: proposes tasks from a repo's goals when its queue runs dry. What it produces are **proposals** (tasks in `proposed`), never plans.

## Operations

**Attention**: the tasks that need a person: blocked, ready for review, or proposed.

**Headline**: the daemon's state in one line (paused, rate limited, on hold, working, idle), with what needs attention.

**Digest**: the live state of a repo's queue in a few lines, for an agent: what changed since it last looked, and what is open.

**Doctor**: the check of the daemon's, or a repo's, health, with what to do about each problem.

## Insights

**Scorecard**: how AgentDeck is doing over time: how much of its work lands without a person stepping in.

**Intervention**: a time a person had to step in to get a task through, which the scorecard counts.

## Contexts

The code is divided into eight bounded contexts. Each owns its words and its rules.

**Work**: repos' tasks, their links, stages and plans.

**Runs**: the attempts at a task, their prompts, syncs and protected edits.

**Landing**: pull requests, checks, reviews and merging.

**Repos**: registered repos, their settings and their health.

**Capacity**: the usage windows, the governor and its holds, and the slots.

**Proposals**: the planner and the proposals it makes.

**Operations**: the daemon itself, its headline, attention list, digest and doctor.

**Insights**: the scorecard and everything counted over time.
