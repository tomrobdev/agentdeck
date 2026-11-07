# Runs

The detail behind [One task's run](../architecture.md#one-tasks-run). Written by hand; `pnpm test` checks that every identifier in backticks is exported from `daemon/src`.

## Plans in a run

Plans live in the database, never in the repo: a plan belongs to the task it was first attached to and is named after it (`planFileName`, as in 112-plans-in-agentdeck.html), and other tasks follow it through their plan_task link. Before claude starts, `writePlanFile` writes the plan the task follows (`followedPlan`) to the worktree's plan file (`PLAN_FILE`), in a folder git ignores. After the run, whatever its outcome, `takePlanFile` reads it back and saves only the task's linked steps into the stored plan (`mergePlanSteps`), so sibling tasks on one plan can run at once; a task with no plan that wrote one gets it as its own. The PR body (`prPlanFor`) reads the stored plan.

## Resuming a run

The run stores claude's session id as soon as `runClaude` reads it off claude's first line. If the daemon restarts mid-run, the next daemon stops the orphaned claude (`reapOrphans`), ends the run as interrupted (`INTERRUPTED`) and requeues the task without using an attempt. The task's next run continues that session with `--resume`, a short prompt and the turns the attempt has left (`resumableSession`, `buildResumePrompt`, `resumeMaxTurns`), looking past a run a rate limit ended since; if claude says it no longer has the session (`resumeFailed`), `startTaskRun` starts a fresh claude in the same run. A task whose prompt or plan a person edited since the cut-off starts afresh instead (`editsSinceCutOff`), with a prompt that carries the last finished run's verdict and final message. Every run first gives back the plan file the last run left (`takePlanFile` is safe to repeat), so a cut-off run's step statuses survive whatever ends the task. After `MAX_RESTARTS` restarts the task fails instead.
