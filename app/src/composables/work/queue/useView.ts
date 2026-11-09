// Requests from the command palette to whatever page is mounted: switch the queue's view (list, board or graph), edit, or a bulk action.
// A request to switch the queue's view (list, board or graph) from outside the queue, such as the command palette. QueueView
// owns the view and its saved setting; it reads this when it mounts and whenever it changes, then clears it.
import { ref } from 'vue';
import type { BulkAction } from '../../../lib/work/queue/bulk';
import type { EditRequest } from '../../../lib/shared/hotkeys';
import type { ViewMode } from '../../../lib/work/palette';

export const requestedView = ref<ViewMode | null>(null);

/** An edit asked for by the command palette (the edit keys' prompt, priority, model or link), for the picked tasks or the selected one. */
export const requestedEdit = ref<EditRequest | null>(null);
/** A bulk action asked for by the command palette, for the picked tasks. */
export const requestedBulk = ref<BulkAction | null>(null);
