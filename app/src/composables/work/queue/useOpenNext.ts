// "Merge and open next": the next task in review, in the queue's order as the stored display and filters make it.
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { tasksQuery } from '../../../api/queries';
import { type Display, boardGroups, normalizeDisplay, rowOrder } from '../../../lib/work/queue/queue-display';
import { nextInReview } from '../../../lib/work/queue/review-nav';
import { loadSetting } from '../../../lib/shared/storage';
import { type Filters, applyFilters, emptyFilters, groupTasks } from '../../../lib/work/task-view';
import { openTask } from '../../../router';

export function useOpenNext() {
  const q = useQuery(tasksQuery());
  const tasks = computed(() => q.data.value ?? []);
  function nextAfter(id: number) {
    const display: Display = normalizeDisplay(loadSetting<unknown>('display', null));
    const filters: Filters = {
      ...emptyFilters(),
      ...loadSetting<Omit<Filters, 'search'>>('filters', { states: [], repos: [], source: null }),
      search: '',
    };
    // The queue's own order, rebuilt from the tasks and the stored view rather than read from the queue's state.
    const board = display.mode === 'board';
    const all = groupTasks(applyFilters(tasks.value, filters), board ? 'status' : display.groupBy, display.sort);
    return nextInReview(rowOrder(board ? boardGroups(all) : all, display), id);
  }
  /** Opens the next task in review on its Changes tab; false when there is none. */
  function openNext(id: number): boolean {
    const next = nextAfter(id);
    if (next) openTask(next.id, 'changes');
    return !!next;
  }
  return { nextAfter, openNext };
}
