// Requests from the command palette to whatever page is mounted: switch the queue's view (list, board or graph), edit, or a bulk action.
import { ref } from 'vue';
import type { BulkAction } from '../../../lib/work/queue/bulk';
import type { EditRequest } from '../../../lib/shared/hotkeys';
import type { ViewMode } from '../../../lib/work/palette';

export const requestedView = ref<ViewMode | null>(null);

export const requestedEdit = ref<EditRequest | null>(null);
export const requestedBulk = ref<BulkAction | null>(null);
