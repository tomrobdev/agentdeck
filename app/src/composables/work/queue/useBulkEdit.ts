// An edit made to several tasks through the same calls as one task's edit: the bar's Edit menu, and the edit keys (p, M, l).
import { landingApi } from '../../../api/landing';
import { workApi } from '../../../api/work';
import type { TaskSummary } from '../../../api/types';
import { errorMessage } from '../../../../../daemon/src/domain/shared/index.ts';
import { type BulkEdit, type BulkResult, bulkEditMessage, planBulkEdit } from '../../../lib/work/queue/bulk';
import { useActions } from '../../shared/useActions';
import { usePicked } from './usePicked';

export type BulkEditValue = number | string | boolean | null;

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
          if (edit === 'priority') await workApi.editTask(id, { priority: value as number });
          else if (edit === 'model') await workApi.editTask(id, { model: value as string });
          else if (edit === 'auto_merge') await landingApi.autoMerge(id, { auto_merge: value as boolean | null });
          else if (on !== undefined) await workApi.linkTask(id, { on, kind: edit });
          else throw new Error('no task to link to');
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
