# Architecture

A map of AgentDeck's code. The blocks between `<!-- generated:NAME -->` and `<!-- /generated -->` are written by `pnpm docs:gen` from the code (Claude's edit hook runs it after each edit under `daemon/src`), and `pnpm test` fails when they are stale. The two sections written by hand are checked too: every file in `daemon/src/adapters/` must be named in the system context, and every identifier in backticks in them must be exported from `daemon/src`. The rules the layers follow are in CLAUDE.md.

## System context

```mermaid
flowchart LR
  dashboard["Dashboard (Tauri app)"]
  cli["agentdeck CLI"]
  subgraph daemon["Daemon (Node)"]
    api["api/"]
    scheduler["application/scheduler"]
    worker["application/run"]
    db["db/"]
    claude["adapters/claude.ts"]
    git["adapters/git.ts"]
    github["adapters/github.ts"]
    service["adapters/service.ts"]
    notify["adapters/notify.ts"]
    processes["adapters/processes.ts"]
    shell["adapters/shell.ts"]
    runlog["adapters/run-log.ts"]
    planfile["adapters/plan-file.ts"]
    protectededits["adapters/protected-edits.ts"]
    goals["adapters/goals.ts"]
    reporoot["adapters/repo-root.ts"]
    watch["adapters/watch.ts"]
    caffeinate["adapters/caffeinate.ts"]
    daemonapi["adapters/daemon-api.ts"]
    daemonlog["adapters/daemon-log.ts"]
  end
  sqlite[("SQLite")]
  claudecli["claude -p"]
  gitbin["git"]
  ghbin["gh"]
  launchd["launchd"]
  notifications["Desktop notifications and ntfy"]
  dashboard -- HTTP --> api
  cli -- "use cases in its own process" --> db
  cli -- "propose and sync, over HTTP" --> api
  api --> scheduler
  scheduler --> worker
  worker --> db
  db --> sqlite
  worker --> claude --> claudecli
  worker --> git --> gitbin
  worker --> github --> ghbin
  worker --> shell
  claude --> processes
  worker --> runlog
  worker -- "the run's plan, in the worktree" --> planfile
  worker -- "edits under .claude/ the worker wrote out" --> protectededits --> git
  scheduler --> goals
  goals --> reporoot
  service --> launchd
  notify --> notifications
  watch -. "source changed" .-> scheduler
  caffeinate -. "keeps the Mac awake" .-> scheduler
  cli -- "agentdeck doctor" --> daemonapi
  cli -- "agentdeck doctor" --> daemonlog
```

## One task's run

`Scheduler` ticks, asks the governor (`decide`, behind `startGate`) whether new work may start, and claims the next queued task into a slot. `runTask` syncs the branch (`syncBranch`), runs claude through `runClaude`, then the repo's tests, and opens the pull request (`openPullRequest`). A repo with auto-merge on is merged by `autoMerge`; otherwise a person merges, and `refreshPrStates` finds the merged PR and moves the task on with the pr_merged event.

Plans live in the database, never in the repo: a plan belongs to the task it was first attached to and is named after it (`planFileName`, as in 112-plans-in-agentdeck.html), and other tasks follow it through their plan_task link. Before claude starts, `writePlanFile` writes the plan the task follows (`followedPlan`) to the worktree's plan file (`PLAN_FILE`), in a folder git ignores. After the run, whatever its outcome, `takePlanFile` reads it back and saves only the task's linked steps into the stored plan (`mergePlanSteps`), so sibling tasks on one plan can run at once; a task with no plan that wrote one gets it as its own. The PR body (`prPlanFor`) reads the stored plan.

The run stores claude's session id as soon as `runClaude` reads it off claude's first line. If the daemon restarts mid-run, the next daemon stops the orphaned claude (`reapOrphans`), ends the run as interrupted (`INTERRUPTED`) and requeues the task without using an attempt. The task's next run continues that session with `--resume`, a short prompt and the turns the attempt has left (`resumableSession`, `buildResumePrompt`, `resumeMaxTurns`), looking past a run a rate limit ended since; if claude says it no longer has the session (`resumeFailed`), `startTaskRun` starts a fresh claude in the same run. A task whose prompt or plan a person edited since the cut-off starts afresh instead (`editsSinceCutOff`), with a prompt that carries the last finished run's verdict and final message. Every run first gives back the plan file the last run left (`takePlanFile` is safe to repeat), so a cut-off run's step statuses survive whatever ends the task. After `MAX_RESTARTS` restarts the task fails instead.

```mermaid
sequenceDiagram
  participant S as Scheduler tick
  participant G as Governor
  participant D as SQLite
  participant W as Worker
  participant C as claude
  participant H as git and gh
  S->>G: may new work start?
  G-->>S: go, or a hold
  S->>D: claim the next queued task (queued to running)
  S->>W: run the task in its worktree
  W->>H: sync: bring the base branch into the task's branch
  W->>C: run claude -p
  C-->>W: result, usage, session
  W->>W: run the repo's tests
  W->>D: finish: done, blocked or failed
  W->>H: push the branch and open the PR
  alt auto-merge allowed
    W->>H: merge the PR
    H-->>W: merged
    W->>D: pr_merged (blocked or failed to done)
  else a person merges
    S->>H: refresh PR states on a later tick
    H-->>S: merged
    S->>D: pr_merged
  end
```

## Layers

Which layers of `daemon/src` import which.

<!-- generated:layers -->

```mermaid
flowchart TD
  adapters["adapters"]
  api["api"]
  application["application"]
  cli["cli"]
  cli_ts["cli.ts"]
  config_ts["config.ts"]
  daemon_ts["daemon.ts"]
  db["db"]
  domain["domain"]
  adapters --> config_ts
  adapters --> domain
  api --> application
  api --> config_ts
  api --> db
  api --> domain
  application --> adapters
  application --> config_ts
  application --> db
  application --> domain
  cli_ts --> application
  cli_ts --> cli
  cli_ts --> db
  cli --> application
  cli --> config_ts
  cli --> daemon_ts
  cli --> db
  cli --> domain
  daemon_ts --> adapters
  daemon_ts --> api
  daemon_ts --> application
  daemon_ts --> config_ts
  daemon_ts --> db
  daemon_ts --> domain
  db --> config_ts
  db --> domain
```

<!-- /generated -->

## Data model

Solid lines are foreign keys. Dotted lines are columns that name another row but have no foreign key.

<!-- generated:data-model -->

```mermaid
erDiagram
  notifications {
    integer id PK
    text kind
    text title
    text body
    integer task_id "nullable"
    text created_at
  }
  planner_runs {
    integer id PK
    integer repo_id FK
    text started_at
    text ended_at "nullable"
    text outcome "nullable"
    integer proposed
    text note "nullable"
    text log_path
    integer pid "nullable"
  }
  repos {
    integer id PK
    text name
    text path
    text base_branch
    text test_cmd "nullable"
    text allowed_tools "nullable"
    text created_at
    integer auto_approve
    text planned_at "nullable"
    text toolchain "nullable"
    text setup_cmd "nullable"
    text paused_reason "nullable"
    text pr_mode
    text merge_method
    integer auto_resolve
    integer sandbox
    text network
    text archived_at "nullable"
    integer auto_merge
    integer auto_merge_max_lines
    text auto_merge_skip
  }
  review_comments {
    integer id PK
    integer review_id FK
    text path
    integer line
    text side
    text head_commit
    text body
    text answer "nullable"
    text state
    text created_at
    text updated_at
  }
  reviews {
    integer id PK
    integer task_id FK
    text kind "nullable"
    text body
    text created_at
    text submitted_at "nullable"
  }
  runs {
    integer id PK
    integer task_id FK
    integer attempt
    text started_at
    text ended_at "nullable"
    text outcome "nullable"
    integer exit_code "nullable"
    text session_id "nullable"
    integer num_turns "nullable"
    integer input_tokens
    integer output_tokens
    integer cache_read_tokens
    integer cache_write_tokens
    real cost_usd
    integer tests_passed "nullable"
    text result_text "nullable"
    text log_path
    integer pid "nullable"
    integer denials
    text kind
    integer live_turns
    text live_tool "nullable"
    text pid_at "nullable"
  }
  settings {
    text key PK
    text value
  }
  task_events {
    integer id PK
    integer task_id
    text type
    text from_status "nullable"
    text to_status "nullable"
    text reason "nullable"
    text at
  }
  task_links {
    integer task_id PK,FK
    integer on_task PK,FK
    text kind
    text created_at
  }
  task_plans {
    integer id PK
    integer task_id
    text name
    text source
    text html
    text created_at
    text updated_at
  }
  tasks {
    integer id PK
    integer repo_id FK
    text title
    text prompt
    text status
    integer priority
    text model
    integer max_turns
    integer attempts
    integer max_attempts
    text branch "nullable"
    text worktree "nullable"
    text stop_reason "nullable"
    text created_at
    text updated_at
    text source
    integer restarts
    text pr_url "nullable"
    text pr_state "nullable"
    integer after_task "nullable"
    text merge_method "nullable"
    text plan_path "nullable"
    text plan_steps "nullable"
    text needs "nullable"
    text done_by "nullable"
    integer auto_merge "nullable"
    text auto_merge_check "nullable"
    text auto_merge_checked_at "nullable"
    text pr_checks_opened "nullable"
    text pr_checks_merged "nullable"
    text merge_requested_at "nullable"
    text merge_request_method "nullable"
    text merge_request_check "nullable"
    integer plan_task "nullable"
    text pr_checks "nullable"
    text syncing_since "nullable"
  }
  usage_samples {
    integer id PK
    text window
    real utilization
    integer resets_at
    text observed_at
  }
  usage_windows {
    text window PK
    real utilization
    integer resets_at
    text status "nullable"
    text observed_at
  }
  repos ||--o{ planner_runs : "repo_id"
  repos ||--o{ tasks : "repo_id"
  reviews ||--o{ review_comments : "review_id"
  tasks |o..o{ notifications : "task_id"
  tasks |o..o{ tasks : "after_task"
  tasks ||--o{ reviews : "task_id"
  tasks ||--o{ runs : "task_id"
  tasks ||--o{ task_links : "on_task"
  tasks ||--o{ task_links : "task_id"
  tasks ||..o{ task_events : "task_id"
  tasks ||..o{ task_plans : "task_id"
```

<!-- /generated -->

## Task lifecycle

<!-- generated:lifecycle -->

```mermaid
stateDiagram-v2
  proposed --> queued: approve
  proposed --> cancelled: cancel, reject
  queued --> running: claim
  queued --> cancelled: cancel
  running --> queued: finish/failed/retry, rate_limited, recover
  running --> done: finish/done
  running --> blocked: finish/blocked
  running --> failed: finish/failed, recover/exhausted
  running --> cancel_requested: cancel
  running --> cancelled: finish/cancelled
  done --> queued: retry
  done --> blocked: conflict
  blocked --> queued: retry
  blocked --> done: mark_done, pr_merged
  blocked --> cancelled: cancel
  failed --> queued: retry
  failed --> done: mark_done, pr_merged
  failed --> cancelled: cancel
  cancel_requested --> cancelled: any run end
  cancelled --> queued: retry
```

<!-- /generated -->

## HTTP API

<!-- generated:routes -->

| Method | Path                               | Use case                                                           |
| ------ | ---------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/daemon/health`               | `actions.daemonReport`                                             |
| POST   | `/api/daemon/restart-now`          | `actions.restartNow`                                               |
| POST   | `/api/daemon/restart`              | `actions.restartDaemon`                                            |
| GET    | `/api/daemon`                      | `actions.daemonState`                                              |
| GET    | `/api/events`                      |                                                                    |
| POST   | `/api/notify/test`                 | `actions.sendTestNotification`                                     |
| POST   | `/api/pause`                       | `actions.setPaused`, `actions.status`                              |
| POST   | `/api/repos/:id/archive`           | `actions.archiveRepo`                                              |
| GET    | `/api/repos/:id/deletion`          | `actions.repoDeletionPreview`                                      |
| POST   | `/api/repos/:id/doctor`            | `actions.doctorRepo`                                               |
| POST   | `/api/repos/:id/plan`              | `actions.proposeNow`                                               |
| POST   | `/api/repos/:id/resume`            | `actions.resumeRepo`                                               |
| POST   | `/api/repos/:id/unarchive`         | `actions.unarchiveRepo`                                            |
| DELETE | `/api/repos/:id`                   | `actions.deleteRepo`                                               |
| GET    | `/api/repos/:id`                   | `actions.repoDetail`                                               |
| POST   | `/api/repos/:id`                   | `actions.updateRepo`                                               |
| GET    | `/api/repos`                       | `db.listRepos`                                                     |
| POST   | `/api/repos`                       | `actions.addRepo`                                                  |
| POST   | `/api/resume`                      | `actions.setPaused`, `actions.status`                              |
| POST   | `/api/review-comments/:id/reopen`  | `actions.reopenReviewComment`                                      |
| POST   | `/api/review-comments/:id/resolve` | `actions.resolveReviewComment`                                     |
| DELETE | `/api/review-comments/:id`         | `actions.deleteReviewComment`                                      |
| POST   | `/api/reviews/:id/comments`        | `actions.addReviewComment`                                         |
| POST   | `/api/reviews/:id/submit`          | `actions.submitReview`                                             |
| POST   | `/api/reviews/:id`                 | `actions.editReview`                                               |
| GET    | `/api/service`                     | `actions.serviceStatus`                                            |
| GET    | `/api/settings`                    | `actions.getSettings`                                              |
| POST   | `/api/settings`                    | `actions.updateSettings`                                           |
| GET    | `/api/stats`                       | `actions.pilotStats`                                               |
| GET    | `/api/status`                      | `actions.status`                                                   |
| POST   | `/api/tasks/:id/approve`           | `actions.approveTask`, `actions.taskDetail`                        |
| POST   | `/api/tasks/:id/auto-merge`        | `actions.setAutoMerge`, `actions.taskDetail`                       |
| POST   | `/api/tasks/:id/cancel`            | `actions.cancelTask`                                               |
| GET    | `/api/tasks/:id/changes`           | `actions.taskChanges`                                              |
| POST   | `/api/tasks/:id/clean`             | `actions.removeTaskWorktree`, `actions.taskDetail`                 |
| POST   | `/api/tasks/:id/close-pr`          | `actions.closeTaskPr`, `actions.taskDetail`                        |
| GET    | `/api/tasks/:id/diff`              | `actions.taskDiff`                                                 |
| POST   | `/api/tasks/:id/done`              | `actions.markDone`, `actions.taskDetail`                           |
| GET    | `/api/tasks/:id/file`              | `actions.taskFile`                                                 |
| POST   | `/api/tasks/:id/fix-checks`        | `actions.fixChecks`, `actions.taskDetail`                          |
| POST   | `/api/tasks/:id/install-needs`     | `actions.installNeeds`, `actions.taskDetail`                       |
| DELETE | `/api/tasks/:id/links/:id2`        | `actions.unlinkTasks`, `actions.taskDetail`                        |
| POST   | `/api/tasks/:id/links`             | `actions.linkTasks`, `actions.taskDetail`                          |
| GET    | `/api/tasks/:id/log`               | `streamLog`                                                        |
| DELETE | `/api/tasks/:id/merge-request`     | `actions.cancelMergeRequest`, `actions.taskDetail`                 |
| POST   | `/api/tasks/:id/merge-request`     | `actions.requestMerge`, `actions.taskDetail`                       |
| GET    | `/api/tasks/:id/merge`             | `actions.mergePreview`                                             |
| POST   | `/api/tasks/:id/merge`             | `actions.mergeTask`, `actions.taskDetail`                          |
| GET    | `/api/tasks/:id/plans/:id2`        | `actions.planHtml`                                                 |
| POST   | `/api/tasks/:id/plans`             | `actions.attachPlan`                                               |
| POST   | `/api/tasks/:id/reject`            | `actions.rejectTask`, `actions.taskDetail`                         |
| POST   | `/api/tasks/:id/retry`             | `actions.retryTask`, `actions.taskDetail`                          |
| GET    | `/api/tasks/:id/reviews`           | `actions.taskReviews`                                              |
| POST   | `/api/tasks/:id/reviews`           | `actions.startReview`                                              |
| POST   | `/api/tasks/:id/sync`              | `actions.syncNow`, `actions.taskDetail`                            |
| GET    | `/api/tasks/:id/tree`              | `actions.taskTree`                                                 |
| GET    | `/api/tasks/:id`                   | `actions.taskDetail`                                               |
| POST   | `/api/tasks/:id`                   | `actions.editTask`, `actions.taskDetail`, `actions.promptWarnings` |
| POST   | `/api/tasks/merge-requests`        | `actions.requestMerges`                                            |
| GET    | `/api/tasks`                       | `actions.taskViews`                                                |
| POST   | `/api/tasks`                       | `actions.addTask`, `actions.taskDetail`, `actions.promptWarnings`  |

<!-- /generated -->

## Settings

<!-- generated:settings -->

| Setting                  | Default                                                         | Meaning                                                                                          |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `five_hour_max`          | `0.85`                                                          | Governor: no new work above this share of the 5-hour window                                      |
| `five_hour_soft`         | `0.6`                                                           | Governor: one task at a time above this share of the 5-hour window                               |
| `max_concurrent`         | `2`                                                             | Slots: how many tasks may run at once                                                            |
| `notify_desktop`         | `1`                                                             | Show desktop notifications                                                                       |
| `notify_events`          | `done,blocked,failed,hold,paused,proposed,merged,checks_failed` | The notification kinds to send, comma-separated                                                  |
| `ntfy_server`            | `https://ntfy.sh`                                               | The ntfy server                                                                                  |
| `ntfy_topic`             | (empty)                                                         | The ntfy topic to push notifications to; empty for none                                          |
| `pace_slack`             | `0.1`                                                           | Governor: how far ahead of the even weekly pace spending may run                                 |
| `paused`                 | `1`                                                             | The daemon starts no new work while this is 1; it starts paused until someone resumes it         |
| `planner_enabled`        | `1`                                                             | Let the planner propose tasks when a repo's queue runs dry                                       |
| `planner_interval_hours` | `3`                                                             | The fewest hours between two planner runs on a repo                                              |
| `planner_max_tasks`      | `3`                                                             | The most proposals one planner run keeps                                                         |
| `planner_model`          | `sonnet`                                                        | The model the planner runs with                                                                  |
| `pr_check_requested`     | `0`                                                             | Set to 1 to have the scheduler check open pull requests on its next tick                         |
| `rate_limited_until`     | `0`                                                             | Unix seconds until which a run that hit the usage limit keeps new work from starting; 0 for none |
| `reload_on_change`       | `0`                                                             | Restart the daemon onto new code when daemon/src changes and nothing is running                  |
| `weekly_max`             | `0.8`                                                           | Governor: the share of the 7-day window the weekly allowance grows to                            |

<!-- /generated -->

## Migrations

<!-- generated:migrations -->

| Step | What it does                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | baseline. Brings a database from any earlier (unversioned) release up to date; the column additions are idempotent because old databases may already have some of them.                                                                   |
| 2    | runsForTask runs on every task view and every 500 ms per open log stream.                                                                                                                                                                 |
| 3    | repo integration. toolchain is detected at `repo add`; setup_cmd runs in each new worktree.                                                                                                                                               |
| 4    | a repo can be paused (doctor failed, setup failed, permissions refused); runs count refused tool uses.                                                                                                                                    |
| 5    | pull requests and task dependencies. pr_mode is off \| draft \| ready; pr_state is open \| merged \| closed.                                                                                                                              |
| 6    | task history. One row per status change, written with the change itself (db/tasks.ts).                                                                                                                                                    |
| 7    | plans attached to a task (domain/plan). One row per plan name; the HTML is parsed on read.                                                                                                                                                |
| 8    | merging a PR from the app. merge_method is squash \| merge \| rebase: the repo's default, and the one a task was merged with.                                                                                                             |
| 9    | keeping task branches up to date with their base. A run is a work run or a resolve run (merging the base into the branch, which uses no attempt); auto_resolve lets the daemon start a resolve run on its own.                            |
| 10   | worker sandbox (docs/adr/0001-worker-sandbox.md). network is a JSON array of hosts sandboxed commands may reach.                                                                                                                          |
| 11   | a task can name the plan and steps it carries out (docs/plans/plan-linked-tasks.html). plan_path is repo-relative under docs/plans/; plan_steps is a JSON array of step ids, NULL for every unfinished step.                              |
| 12   | archiving a repo (docs/plans/repo-archive.html). archived_at is when it was archived, NULL while it is active.                                                                                                                            |
| 13   | what a blocked worker said it needs (docs/plans/fewer-blocks.html): JSON { kind, items }, NULL when nothing.                                                                                                                              |
| 14   | who said a task is done (docs/plans/manual-moves.html): 'person' when mark_done set it, NULL otherwise.                                                                                                                                   |
| 15   | the stop reason, named for the domain language (docs/plans/domain-model.html).                                                                                                                                                            |
| 16   | a paused repo notifies with its own kind, `paused`, instead of `hold`. Whoever listened for `hold` keeps hearing both.                                                                                                                    |
| 17   | auto-merge (docs/plans/auto-merge.html). auto_merge_skip is a JSON array of path prefixes that need a person; a task's auto_merge is NULL (its repo's), 0 or 1.                                                                           |
| 18   | task links (docs/plans/task-links.html). kind is builds_on \| after. after_task is copied in and no longer read.                                                                                                                          |
| 19   | the latest auto-merge check of a done task's open PR (docs/plans/auto-merge-view.html): JSON { verdict, reasons }, NULL when none; auto_merge_checked_at is when the PR refresh made it.                                                  |
| 20   | reviews made in the dashboard (docs/plans/review-merge.html). A review is a draft until submitted_at is set; kind is comment \| request_changes. A comment's state is open \| answered \| resolved; side is old \| new.                   |
| 21   | what a live run is doing: turns so far and the last tool call, kept from its stream while it runs.                                                                                                                                        |
| 22   | what the pilot scorecard needs and nothing kept. usage_samples is a history of usage readings, appended when a window's reading changes; pr_checks_opened / pr_checks_merged are JSON { total, failing, pending } of a PR's checks.       |
| 23   | merge requests (docs/plans/merge-requests.html). merge_requested_at is when a person asked the daemon to merge the task's PR once it is ready (NULL: no request); merge_request_check is the last check's JSON { verdict, reasons }.      |
| 24   | plans live in AgentDeck, named after the task they belong to. plan_task is the task whose plan this one follows (itself when its own plan was given with --plan); plan_steps names that plan's steps. plan_path is no longer written.     |
| 25   | when a run's pid was stored. Its claude started then, which can be minutes after the run row (setup, a sync), so crash recovery and the doctor tell our claude from a reused pid by this time, not by started_at.                         |
| 26   | an open PR's latest checks, one by one (domain/pull-request/checks.ts StoredChecks): JSON { read_at, head, checks, notified }, written by the PR refresh; notified says a person was told they fail. NULL until the PR's checks are read. |
| 27   | when a sync of the task's branch began (NULL when none is running). Syncs run in the daemon only, so the CLI reads this to see one; the daemon clears every marker on start.                                                              |

<!-- /generated -->
