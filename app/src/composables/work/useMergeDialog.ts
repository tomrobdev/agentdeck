// The merge dialog the shell opens (`startMerge`), for the task being merged. Closing it after a merge or a merge request
// may open the next task in review, so it sits in work/ beside the queue's order (useOpenNext) rather than in landing/.
import type { MergeResult } from '../../api/types';
import type { Actions } from '../shared/useActions';
import { merging } from '../shared/useShell';
import { useOpenNext } from './queue/useOpenNext';

/** App passes the actions it provides, since a component cannot inject what it provides itself. */
export function useMergeDialog({ refresh, flash }: Pick<Actions, 'refresh' | 'flash'>) {
  const { nextAfter, openNext } = useOpenNext();
  /** A merge request was made: close the dialog, and open the next task in review when asked. */
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
