// Plan branches: one per (plan task, repo), each status change a guarded update, and the targets of the tasks on them.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import {
  type PlanBranch,
  type PlanBranchMove,
  type PlanBranchSyncOutcome,
  type PlanBranchTask,
  RUNNING_STATUSES,
  abandonRunningError,
  nextPlanBranchStatus,
  planBranchStatusesFor,
  planBranchSyncMove,
  planBranchTargetChanges,
  tasksBackToBase,
} from '#domain/work/index.ts';
import { mapFound, toPlanBranch } from '#db/mappers.ts';
import type { Orm } from '#db/orm.ts';
import { NOW_SQL, atomically } from '#db/sql.ts';
import { planBranches, tasks } from '#db/tables.ts';
import { columns } from '#db/work/tasks-columns.ts';

export interface NewPlanBranch {
  plan_task: TaskId;
  repo_id: RepoId;
  name: string;
  base: string;
}

export type AbandonOutcome = { abandoned: PlanBranch; moved: TaskId[] } | { refused: string };

export function planBranchStore(db: DatabaseSync, orm: Orm) {
  const onTarget = (repo_id: RepoId, name: string): PlanBranchTask[] =>
    orm
      .select({ id: tasks.id, target: tasks.target, branch: tasks.branch, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.repo_id, repo_id), eq(tasks.target, name)))
      .all()
      .map((t) => ({ id: t.id, target: t.target, started: t.branch !== null, running: RUNNING_STATUSES.includes(t.status) }));

  const setTargets = (ids: TaskId[], name: string | null, from: string | null) => {
    if (!ids.length) return [];
    return orm
      .update(tasks)
      .set({ ...columns(planBranchTargetChanges(name)), updated_at: NOW_SQL })
      .where(and(inArray(tasks.id, ids), from === null ? isNull(tasks.target) : eq(tasks.target, from), isNull(tasks.branch)))
      .returning({ id: tasks.id })
      .all()
      .map((t) => t.id);
  };

  const move = (id: number, to: PlanBranchMove, fields: { head_commit?: string; pr_url?: string; synced_at?: typeof NOW_SQL } = {}) => {
    const row = orm.select({ status: planBranches.status }).from(planBranches).where(eq(planBranches.id, id)).get();
    const status = row && nextPlanBranchStatus(row.status, to);
    if (!status) return undefined;
    return mapFound(
      orm
        .update(planBranches)
        .set({ ...fields, status, updated_at: NOW_SQL })
        .where(and(eq(planBranches.id, id), inArray(planBranches.status, planBranchStatusesFor(to))))
        .returning()
        .get(),
      toPlanBranch,
    );
  };

  return {
    planBranchOf(plan_task: TaskId, repo_id: RepoId): PlanBranch | undefined {
      return mapFound(
        orm
          .select()
          .from(planBranches)
          .where(and(eq(planBranches.plan_task, plan_task), eq(planBranches.repo_id, repo_id)))
          .get(),
        toPlanBranch,
      );
    },
    planBranchNamed(repo_id: RepoId, name: string): PlanBranch | undefined {
      return mapFound(
        orm
          .select()
          .from(planBranches)
          .where(and(eq(planBranches.repo_id, repo_id), eq(planBranches.name, name)))
          .get(),
        toPlanBranch,
      );
    },
    openPlanBranch(branch: NewPlanBranch, retarget: TaskId[]): { opened: PlanBranch; targeted: TaskId[] } {
      return atomically(db, () => {
        const opened = toPlanBranch(orm.insert(planBranches).values(branch).returning().get());
        return { opened, targeted: setTargets(retarget, branch.name, null) };
      });
    },
    cutPlanBranch(id: number, head_commit: string): PlanBranch | undefined {
      return move(id, 'cut', { head_commit, synced_at: NOW_SQL });
    },
    syncedPlanBranches(): PlanBranch[] {
      return orm
        .select()
        .from(planBranches)
        .where(inArray(planBranches.status, ['active', 'conflict']))
        .orderBy(asc(planBranches.id))
        .all()
        .map(toPlanBranch);
    },
    recordPlanBranchSync(
      branch: Pick<PlanBranch, 'id' | 'status'>,
      outcome: PlanBranchSyncOutcome,
      head_commit: string | null,
    ): PlanBranch | undefined {
      const fields = { synced_at: NOW_SQL, ...(head_commit ? { head_commit } : {}) };
      const to = planBranchSyncMove(branch, outcome);
      if (to) return move(branch.id, to, fields);
      return mapFound(
        orm
          .update(planBranches)
          .set({ ...fields, updated_at: NOW_SQL })
          .where(and(eq(planBranches.id, branch.id), eq(planBranches.status, branch.status)))
          .returning()
          .get(),
        toPlanBranch,
      );
    },
    abandonPlanBranch(branch: Pick<PlanBranch, 'id' | 'repo_id' | 'name'>): AbandonOutcome | undefined {
      return atomically(db, () => {
        const on = onTarget(branch.repo_id, branch.name);
        const running = abandonRunningError(branch.name, on);
        if (running) return { refused: running };
        const abandoned = move(branch.id, 'abandon');
        if (!abandoned) return undefined;
        return { abandoned, moved: setTargets(tasksBackToBase(on, branch.name), null, branch.name) };
      });
    },
  };
}
