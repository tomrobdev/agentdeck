// "Merge and open next": the next task in review, in the queue's order as the stored display and filters make it.
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { tasksQuery } from '../../../api/work';
import { type Display, boardGroups, normalizeDisplay, rowOrder } from '../../../lib/work/queue/queue-display';
import { nextInReview } from '../../../lib/work/queue/review-nav';
import { loadSetting } from '../../../lib/shared/storage';
import { type Filters, applyFilters, emptyFilters, groupTasks } from '../../../lib/work/task-view';

export function useOpenNext() {
  const router = useRouter();
  const q = useQuery(tasksQuery());
  const tasks = computed(() => q.data.value ?? []);
  function nextAfter(id: number) {
    const display: Display = normalizeDisplay(loadSetting<unknown>('display', null));
    const filters: Filters = {
      ...emptyFilters(),
      ...loadSetting<Omit<Filters, 'search'>>('filters', { states: [], repos: [], source: null }),
      search: '',
    };
    const board = display.mode === 'board';
    const all = groupTasks(applyFilters(tasks.value, filters), board ? 'status' : display.groupBy, display.sort);
    return nextInReview(rowOrder(board ? boardGroups(all) : all, display), id);
  }
  function openNext(id: number): boolean {
    const next = nextAfter(id);
    if (next) void router.push({ name: 'task', params: { id: next.id, tab: 'changes' } });
    return !!next;
  }
  return { nextAfter, openNext };
}
