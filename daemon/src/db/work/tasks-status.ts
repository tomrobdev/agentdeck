// A task's status changes only here: through applyEvent, the claim and crash recovery included, guarded by the current status.
import { type SQL, and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, or } from 'drizzle-orm';
import { type AnySQLiteColumn, alias } from 'drizzle-orm/sqlite-core';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskId } from '../../domain/shared/index.ts';
import { INTERRUPTED, type RunOutcome } from '../../domain/runs/index.ts';
import {
  type DomainEvent,
  RUNNING_STATUSES,
  type Needs,
  type Task,
  type TaskEvent,
  type TaskStatus,
  followUpsOf,
  fromStatuses,
  transition,
} from '../../domain/work/index.ts';
import { TASK_COLUMNS, mapFound, stateColumns, toTask } from '../mappers.ts';
import type { Orm } from '../orm.ts';
import { NOW_SQL, atomically } from '../sql.ts';
import { plannerRuns, repos, runs, taskLinks, tasks } from '../tables.ts';
import { recordEvent } from './task-events.ts';
import { columns } from './tasks-columns.ts';

/**
 * The task's PR state is still the one `task` was read with: a PR the task has no value for (`pullRequestOf`) has no state,
 * or no url and a state other than failed.
 */
const prStateAsRead = (task: Task): SQL | undefined =>
  task.pr ? eq(tasks.pr_state, task.pr.state) : or(isNull(tasks.pr_state), and(isNull(tasks.pr_url), ne(tasks.pr_state, 'failed')));

/** The task row `t` in the claim and queue queries, which `notWaiting` refers to. */
const t = alias(tasks, 't');
/** A builds-on link of `t`, the task `d` it builds on, and `d`'s repo `r`: what `notWaiting` looks through. */
const buildsOn = alias(taskLinks, 'l');
const dep = alias(tasks, 'd');
const depRepo = alias(repos, 'r');

export function taskStatusStore(db: DatabaseSync, orm: Orm, getTask: (id: TaskId) => Task | undefined) {
  /** The repo id column `col` belongs to a repo work may start in: not paused and not archived. */
  const inOpenRepo = (col: AnySQLiteColumn) =>
    inArray(
      col,
      orm
        .select({ id: repos.id })
        .from(repos)
        .where(and(isNull(repos.paused_reason), isNull(repos.archived_at))),
    );
  /**
   * The task row `t` is free to start: every task it builds on is met, that is done, and merged unless its repo has pr_mode off.
   * A done task with no PR state (none opened yet, or an earlier one set aside by a retry) counts as met only in a repo with
   * pr_mode off. A task a person marked done counts as met unless its PR is open. After links never stop a start.
   * Mirrors startState and domain/work/link.ts.
   */
  const notWaiting = () => {
    const met = and(
      eq(dep.status, 'done'),
      or(
        eq(dep.pr_state, 'merged'),
        and(
          isNull(dep.pr_state),
          exists(
            orm
              .select({ id: depRepo.id })
              .from(depRepo)
              .where(and(eq(depRepo.id, dep.repo_id), eq(depRepo.pr_mode, 'off'))),
          ),
        ),
        and(eq(dep.done_by, 'person'), or(isNull(dep.pr_state), ne(dep.pr_state, 'open'))),
      ),
    );
    const unmet = orm
      .select({ id: dep.id })
      .from(dep)
      .where(and(eq(dep.id, buildsOn.on_task), met));
    return notExists(
      orm
        .select({ task_id: buildsOn.task_id })
        .from(buildsOn)
        .where(and(eq(buildsOn.task_id, t.id), eq(buildsOn.kind, 'builds_on'), notExists(unmet))),
    );
  };
  /**
   * The task row `t` has no unblock or review run going: a retry during one (a person's, or the review run's own) waits
   * for it to end before a claim, so a review run's retry is claimed only once its review is stored.
   */
  const notUnblocking = () =>
    notExists(
      orm
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.task_id, t.id), inArray(runs.kind, ['unblock', 'review']), isNull(runs.ended_at))),
    );
  /**
   * The task row `t` may be claimed: in a status a claim is allowed from (queued), not waiting on a task it builds on, with no
   * unblock run going, in a repo work may start in. The one definition, for the claim and `hasQueued`; mirrors `startWait`
   * in domain/work/start.ts, but for the slots, which the scheduler counts.
   */
  const claimable = () => and(inArray(t.status, fromStatuses({ type: 'claim' })), notWaiting(), notUnblocking(), inOpenRepo(t.repo_id));

  /**
   * The only way to change a task's status. Asks the lifecycle whether `event` is allowed from the
   * task's current status and writes the result guarded by that status, so a concurrent change
   * (say, a cancel arriving as a run finishes) is never overwritten. Returns the updated task, or
   * undefined if the task is missing or the event isn't allowed. `onlyFrom` narrows it further: the write also
   * requires the task to be in one of those statuses, so a caller that checked a status before a long wait
   * does not undo a change made meanwhile.
   */
  const applyEvent = (
    id: TaskId,
    event: TaskEvent,
    opts: { reason?: string | null; needs?: Needs | null; onlyFrom?: TaskStatus[] } = {},
  ): { task: Task; event: DomainEvent; pending: number[] } | undefined => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = getTask(id);
      if (!cur) return undefined;
      if (opts.onlyFrom && !opts.onlyFrom.includes(cur.status)) return undefined;
      const next = transition(cur, event, opts);
      if (!next) return undefined;
      const pending: number[] = [];
      const task = atomically(db, () => {
        // Guarded on the status, the counters and the PR state the changes were computed from.
        const row = mapFound(
          orm
            .update(tasks)
            .set({
              status: next.state.status,
              ...stateColumns(next.state),
              ...next.counters,
              ...columns(next.changes),
              updated_at: NOW_SQL,
            })
            .where(
              and(
                eq(tasks.id, id),
                eq(tasks.status, cur.status),
                eq(tasks.attempts, cur.attempts),
                eq(tasks.max_attempts, cur.max_attempts),
                eq(tasks.restarts, cur.restarts),
                prStateAsRead(cur),
              ),
            )
            .returning(TASK_COLUMNS)
            .get(),
          toTask,
        );
        // An event with follow-ups is written pending, in the same transaction as the change: the outbox.
        if (row) {
          const e = next.event;
          const followUp = followUpsOf(e).length > 0;
          const eventId = recordEvent(orm, e.task_id, e.history, e.from, e.to, e.reason, followUp);
          if (followUp) pending.push(eventId);
        }
        return row;
      });
      if (task) return { task, event: next.event, pending };
    }
    return undefined;
  };

  return {
    applyEvent,
    /** Whether a task could be claimed (`claimable`). */
    hasQueued(): boolean {
      return !!orm.select({ id: t.id }).from(t).where(claimable()).limit(1).get();
    },
    /**
     * Claim the next claimable task (`claimable`), by priority then id, or undefined if none: the claim goes through
     * applyEvent like every status change, trying the next task if its guarded write misses. The read and the claim are one
     * unit, so an unblock run cannot start between them.
     */
    claimNextTask(): Task | undefined {
      return atomically(db, () => {
        const ids = orm.select({ id: t.id }).from(t).where(claimable()).orderBy(desc(t.priority), asc(t.id)).all();
        for (const { id } of ids) {
          const claimed = applyEvent(id, { type: 'claim' });
          if (claimed) return claimed.task;
        }
        return undefined;
      });
    },
    /**
     * After a crash, anything still marked running was orphaned: put it back in the queue,
     * unless restarts keep interrupting it. Stop its claude process (`reapOrphans`) first.
     * The unfinished runs of a requeued task end `interrupted`, keeping their session, so the next run resumes it; those
     * of a task that failed or was cancelled end so (`failed`, `cancelled`), so the run stats count them. Any other
     * unfinished run (a done task's resolve run, a blocked task's unblock run) ends `interrupted`. Returns how many were
     * requeued and the ids of those failed.
     */
    recoverOrphans(): { requeued: number; failed: TaskId[] } {
      // Syncs run only in the daemon, so any marker left over belongs to a sync that died with it.
      orm.update(tasks).set({ syncing_since: null }).where(isNotNull(tasks.syncing_since)).run();
      const endRuns = (outcome: RunOutcome, task_id?: TaskId) =>
        orm
          .update(runs)
          .set({ ended_at: NOW_SQL, outcome, result_text: 'daemon restarted' })
          .where(and(isNull(runs.ended_at), task_id === undefined ? undefined : eq(runs.task_id, task_id)))
          .run();
      orm
        .update(plannerRuns)
        .set({ ended_at: NOW_SQL, outcome: 'failed', note: 'daemon restarted' })
        .where(isNull(plannerRuns.ended_at))
        .run();
      let requeued = 0;
      const failed: TaskId[] = [];
      const orphans = orm
        .select({ id: tasks.id, restarts: tasks.restarts })
        .from(tasks)
        .where(inArray(tasks.status, RUNNING_STATUSES))
        .all();
      for (const o of orphans) {
        const reason = `the daemon restarted ${o.restarts + 1} times while this task was running`;
        atomically(db, () => {
          const task = applyEvent(o.id, { type: 'recover' }, { reason })?.task;
          if (task?.status === 'queued') requeued++;
          else if (task?.status === 'failed') failed.push(task.id);
          if (task?.status === 'failed' || task?.status === 'cancelled') endRuns(task.status, task.id);
        });
      }
      endRuns(INTERRUPTED);
      return { requeued, failed };
    },
  };
}
