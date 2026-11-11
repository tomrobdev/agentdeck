import type { MergeResult } from '#api/types.ts';
import type { Actions } from '#composables/shared/useActions.ts';
import { merging } from '#composables/shared/useShell.ts';
import { useOpenNext } from '#composables/work/queue/useOpenNext.ts';

export function useMergeDialog({ refresh, flash }: Pick<Actions, 'refresh' | 'flash'>) {
  const { nextAfter, openNext } = useOpenNext();
  function onRequested(next: boolean) {
    const id = merging.value;
    merging.value = null;
    if (next && id !== null) openNext(id);
  }
  async function onMerged(result: MergeResult, next: boolean) {
    onRequested(next);
    await refresh();
    if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
  }
  const close = () => (merging.value = null);
  return { merging, nextAfter, onMerged, onRequested, close };
}
