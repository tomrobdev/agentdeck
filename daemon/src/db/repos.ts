// Registered repos.
import type { DatabaseSync } from 'node:sqlite';
import type { Repo } from '../domain/repo/repo.ts';
import { NOW, atomically } from './sql.ts';

export function repoStore(db: DatabaseSync) {
  return {
    addRepo(r: {
      name: string;
      path: string;
      base_branch: string;
      test_cmd?: string | null;
      allowed_tools?: string[] | null;
      toolchain?: string | null;
      setup_cmd?: string | null;
    }): Repo {
      const info = db
        .prepare('INSERT INTO repos (name, path, base_branch, test_cmd, allowed_tools, toolchain, setup_cmd) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          r.name,
          r.path,
          r.base_branch,
          r.test_cmd ?? null,
          r.allowed_tools ? JSON.stringify(r.allowed_tools) : null,
          r.toolchain ?? null,
          r.setup_cmd ?? null,
        );
      return this.getRepo(Number(info.lastInsertRowid))!;
    },
    getRepo(id: number): Repo | undefined {
      return db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined;
    },
    findRepo(nameOrId: string): Repo | undefined {
      return db.prepare('SELECT * FROM repos WHERE name = ? OR id = ?').get(nameOrId, Number(nameOrId) || -1) as Repo | undefined;
    },
    /** Active repos, or with `{ archived: true }` only the archived ones. */
    listRepos(opts: { archived?: boolean } = {}): Repo[] {
      const where = opts.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL';
      return db.prepare(`SELECT * FROM repos WHERE ${where} ORDER BY name`).all() as unknown as Repo[];
    },
    /** Archive (true) or unarchive (false) a repo. */
    setRepoArchived(id: number, archived: boolean): void {
      db.prepare(`UPDATE repos SET archived_at = ${archived ? NOW : 'NULL'} WHERE id = ?`).run(id);
    },
    /** Whether a task of the repo is running or has a cancel requested. */
    repoHasRunning(id: number): boolean {
      return !!db.prepare("SELECT 1 FROM tasks WHERE repo_id = ? AND status IN ('running', 'cancel_requested') LIMIT 1").get(id);
    },
    /** What deleting the repo takes with it: its tasks' checkouts and every log file its runs and planner runs wrote. */
    repoFootprint(id: number): {
      tasks: { id: number; branch: string | null; worktree: string | null }[];
      run_logs: string[];
      planner_logs: string[];
    } {
      const tasks = db.prepare('SELECT id, branch, worktree FROM tasks WHERE repo_id = ? ORDER BY id').all(id) as unknown as {
        id: number;
        branch: string | null;
        worktree: string | null;
      }[];
      const logs = (sql: string) => (db.prepare(sql).all(id) as unknown as { log_path: string }[]).map((r) => r.log_path);
      return {
        tasks,
        run_logs: logs('SELECT log_path FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE repo_id = ?)'),
        planner_logs: logs('SELECT log_path FROM planner_runs WHERE repo_id = ?'),
      };
    },
    /** Delete a repo and everything of it in one transaction, children first. Only an archived repo; returns false otherwise. */
    deleteRepo(id: number): boolean {
      return atomically(db, () => {
        if (!db.prepare('SELECT 1 FROM repos WHERE id = ? AND archived_at IS NOT NULL').get(id)) return false;
        const mine = 'SELECT id FROM tasks WHERE repo_id = ?';
        db.prepare(`DELETE FROM task_events WHERE task_id IN (${mine})`).run(id);
        db.prepare(`DELETE FROM task_plans WHERE task_id IN (${mine})`).run(id);
        db.prepare(`DELETE FROM runs WHERE task_id IN (${mine})`).run(id);
        db.prepare(`DELETE FROM notifications WHERE task_id IN (${mine})`).run(id);
        db.prepare('DELETE FROM tasks WHERE repo_id = ?').run(id);
        db.prepare('DELETE FROM planner_runs WHERE repo_id = ?').run(id);
        db.prepare('DELETE FROM repos WHERE id = ?').run(id);
        return true;
      });
    },
    updateRepo(
      id: number,
      fields: Partial<
        Pick<
          Repo,
          | 'auto_approve'
          | 'test_cmd'
          | 'setup_cmd'
          | 'planned_at'
          | 'base_branch'
          | 'pr_mode'
          | 'merge_method'
          | 'auto_resolve'
          | 'sandbox'
          | 'network'
        >
      >,
    ): void {
      const keys = Object.keys(fields) as (keyof typeof fields)[];
      if (!keys.length) return;
      db.prepare(`UPDATE repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    },
    /** Pause (reason) or resume (null) a repo unconditionally. */
    setRepoPaused(id: number, reason: string | null): void {
      db.prepare('UPDATE repos SET paused_reason = ? WHERE id = ?').run(reason, id);
    },
    /** Pause a repo that isn't paused yet. Returns false if it already was, keeping the first reason. */
    pauseRepo(id: number, reason: string): boolean {
      const res = db.prepare('UPDATE repos SET paused_reason = ? WHERE id = ? AND paused_reason IS NULL').run(reason, id);
      return Number(res.changes) > 0;
    },
  };
}
