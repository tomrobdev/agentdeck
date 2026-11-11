// A task's status changes only here: through applyEvent, the claim and crash recovery included, guarded by the current status.
import { type SQL, and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, or } from 'drizzle-orm';
import { type AnySQLiteColumn, alias } from 'drizzle-orm/sqlite-core';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskId } from '#domain/shared/index.ts';
import { INTERRUPTED, type RunOutcome } from '#domain/runs/index.ts';
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
} from '#domain/work/index.ts';
import { TASK_COLUMNS, mapFound, stateColumns, toTask } from '#db/mappers.ts';
import type { Orm } from '#db/orm.ts';
import { NOW_SQL, atomically } from '#db/sql.ts';
import { plannerRuns, repos, runs, taskLinks, tasks } from '#db/tables.ts';
import { recordEvent } from '#db/work/task-events.ts';
import { columns } from '#db/work/tasks-columns.ts';

const prStateAsRead = (task: Task): SQL | undefined =>
  task.pr ? eq(tasks.pr_state, task.pr.state) : or(isNull(tasks.pr_state), and(isNull(tasks.pr_url), ne(tasks.pr_state, 'failed')));

const t = alias(tasks, 't');
const buildsOn = alias(taskLinks, 'l');
const dep = alias(tasks, 'd');
const depRepo = alias(repos, 'r');

export function taskStatusStore(db: DatabaseSync, orm: Orm, getTask: (id: TaskId) => Task | undefined) {
  const inOpenRepo = (col: AnySQLiteColumn) =>
    inArray(
      col,
      orm
        .select({ id: repos.id })
        .from(repos)
        .where(and(isNull(repos.paused_reason), isNull(repos.archived_at))),
    );
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
  const notUnblocking = () =>
    notExists(
      orm
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.task_id, t.id), inArray(runs.kind, ['unblock', 'review']), isNull(runs.ended_at))),
    );
  const claimable = () => and(inArray(t.status, fromStatuses({ type: 'claim' })), notWaiting(), notUnblocking(), inOpenRepo(t.repo_id));

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
    hasQueued(): boolean {
      return !!orm.select({ id: t.id }).from(t).where(claimable()).limit(1).get();
    },
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
    recoverOrphans(): { requeued: number; failed: TaskId[] } {
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
