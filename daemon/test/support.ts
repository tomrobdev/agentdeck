// Helpers for tests that need a task in a state the daemon only reaches through several steps.
import type { openDb } from '../src/db/index.ts';

type Db = ReturnType<typeof openDb>;

/** Put a task's PR in any state, unguarded and without history: test setup only, the daemon goes through db.recordPr. */
export function setPr(
  db: Db,
  id: number,
  fields: { pr_url?: string | null; pr_state?: 'open' | 'closed' | 'merged' | 'failed' | null },
): void {
  for (const [column, value] of Object.entries(fields)) db.raw.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, id);
}
