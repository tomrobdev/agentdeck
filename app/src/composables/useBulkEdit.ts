// An edit made to several tasks through the same calls as one task's edit: the bar's Edit menu, and the edit keys (p, M, l).
import { type TaskSummary, api } from '../api';
import { errorMessage } from '../../../daemon/src/domain/shared/index.ts';
import { type BulkEdit, type BulkResult, bulkEditMessage, planBulkEdit } from '../lib/bulk';
import { useActions } from './useActions';
import { usePicked } from './usePicked';

/** What a bulk edit sets: a priority, a model, or auto-merge (true, false, null for the repo's setting); a link has none. */
export type BulkEditValue = number | string | boolean | null;

/**
 * `run` wraps the calls (it refreshes and shows a pending state). The returned function edits every task in `targets` that
 * allows the edit; the rest are left out and named in the toast, with the failures. With `fromPicks`, the tasks the edit
 * worked on are unpicked and the others stay picked.
 */
export function useBulkEdit(run: (fn: () => Promise<unknown>) => Promise<unknown>) {
  const { flash } = useActions();
  const { setPicked } = usePicked();
  return async function bulkEdit(
    targets: TaskSummary[],
    edit: BulkEdit,
    value: BulkEditValue,
    label: string,
    on?: number,
    fromPicks = false,
  ) {
    const { allowed, left } = planBulkEdit(targets, edit, on);
    const results: BulkResult[] = [];
    await run(async () => {
      for (const id of allowed) {
        try {
          if (edit === 'priority') await api.editTask(id, { priority: value as number });
          else if (edit === 'model') await api.editTask(id, { model: value as string });
          else if (edit === 'auto_merge') await api.autoMerge(id, { auto_merge: value as boolean | null });
          else await api.linkTask(id, { on: on!, kind: edit });
          results.push({ id });
        } catch (e) {
          results.push({ id, error: errorMessage(e) });
        }
      }
    });
    flash(bulkEditMessage(edit, results, left, on !== undefined ? `#${on}` : label));
    if (fromPicks) setPicked([...results.filter((r) => r.error !== undefined).map((r) => r.id), ...left.map((l) => l.id)]);
  };
}
