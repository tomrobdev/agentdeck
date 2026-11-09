// The one gate every approval passes through: the task page, the list row, the row menu, the `a` key, the palette, a board
// drag and the bulk bar all call `approve`. App provides it (it shows the dialog); components `useApprovals()` it.
import { type InjectionKey, inject, provide, ref } from 'vue';
import type { QueryClient } from '@tanstack/vue-query';
import { errorMessage } from '../../../../daemon/src/domain/shared/index.ts';
import { PERSON_CALLS, proposalCheckQuery } from '../../api/work';
import {
  type ApproveDialogSetting,
  type ApproveItem,
  type ApprovePlan,
  DEFAULT_APPROVE_DIALOG,
  approveDialog,
  asApproveDialogSetting,
} from '../../lib/work/approve-dialog';
import { type BulkResult, bulkMessage } from '../../lib/work/queue/bulk';
import { loadSetting, saveSetting } from '../../lib/shared/storage';
import type { Actions } from '../shared/useActions';

export type Approvals = {
  /**
   * Approves the tasks, after a dialog when one has something to show. Resolves with each task's result, or null when the
   * person dismissed the dialog and nothing was approved. It says what happened itself (a toast, or the dialog's own report).
   */
  approve: (ids: number[]) => Promise<BulkResult[] | null>;
};

const KEY: InjectionKey<Approvals> = Symbol('approvals');

/** An approval waiting on the dialog: its tasks with their checks, what the dialog ticks, and how to answer the caller. */
export type ApproveRequest = { items: ApproveItem[]; plan: ApprovePlan; resolve: (results: BulkResult[] | null) => void };

/**
 * The gate, for App to provide. It reads each task's proposal check, and opens the dialog (`approving`) when the setting
 * and the checks say so; else it approves at once. A check that can't be read counts as nothing to show. App shows the
 * dialog while `approving` is set and passes its answer to `answer`.
 */
export function provideApprovals(queryClient: QueryClient, { refresh, flash }: Pick<Actions, 'refresh' | 'flash'>) {
  const approving = ref<ApproveRequest | null>(null);

  async function approveNow(ids: number[]): Promise<BulkResult[]> {
    const results: BulkResult[] = [];
    for (const id of ids) {
      try {
        await PERSON_CALLS.approve(id);
        results.push({ id });
      } catch (e) {
        results.push({ id, error: errorMessage(e) });
      }
    }
    await refresh();
    // One task that worked is the row changing; anything else is said.
    if (ids.length > 1 || results.some((r) => r.error !== undefined)) flash(bulkMessage('approve', results));
    return results;
  }

  async function approve(ids: number[]): Promise<BulkResult[] | null> {
    const setting = approveDialogSetting.value;
    if (setting === 'never') return approveNow(ids);
    const items = await Promise.all(
      ids.map(async (id) => ({
        id,
        check: await queryClient.fetchQuery({ ...proposalCheckQuery(id), staleTime: 0 }).catch(() => null),
      })),
    );
    const plan = approveDialog(items, setting);
    if (!plan.open) return approveNow(ids);
    return new Promise((resolve) => (approving.value = { items, plan, resolve }));
  }

  function answer(results: BulkResult[] | null) {
    approving.value?.resolve(results);
    approving.value = null;
  }

  provide(KEY, { approve } satisfies Approvals);
  return { approve, approving, answer };
}

export function useApprovals(): Approvals {
  const approvals = inject(KEY);
  if (!approvals) throw new Error('useApprovals() needs App to provideApprovals() first');
  return approvals;
}

/** The dashboard's own setting for when approving opens the dialog, kept on this computer; not a daemon setting. */
export const approveDialogSetting = ref<ApproveDialogSetting>(
  asApproveDialogSetting(loadSetting<unknown>('approveDialog', DEFAULT_APPROVE_DIALOG)),
);

export function setApproveDialogSetting(value: ApproveDialogSetting) {
  approveDialogSetting.value = value;
  saveSetting('approveDialog', value);
}
