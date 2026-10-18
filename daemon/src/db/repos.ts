// Registered repos.
import type { DatabaseSync } from 'node:sqlite';
import type { Repo } from '../domain/repo/repo.ts';

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
    listRepos(): Repo[] {
      return db.prepare('SELECT * FROM repos ORDER BY name').all() as unknown as Repo[];
    },
    updateRepo(
      id: number,
      fields: Partial<Pick<Repo, 'auto_approve' | 'test_cmd' | 'setup_cmd' | 'planned_at' | 'base_branch' | 'pr_mode'>>,
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
