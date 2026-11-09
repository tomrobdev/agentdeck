// The status bar's activity list, from the task list and status the window already reads; nothing is polled for it.
import { type MaybeRefOrGetter, computed, toValue } from 'vue';
import type { Status, TaskSummary } from '../../api';
import { activityItems } from '../../lib/queue/activity';

export function useActivity(tasks: MaybeRefOrGetter<TaskSummary[]>, status: MaybeRefOrGetter<Status | null>) {
  return computed(() => activityItems(toValue(tasks), toValue(status)));
}
