// A request to switch the queue's view (list, board or graph) from outside the queue, such as the command palette. QueueView
// owns the view and its saved setting; it reads this when it mounts and whenever it changes, then clears it.
import { ref } from 'vue';
import type { ViewMode } from '../lib/palette';

export const requestedView = ref<ViewMode | null>(null);
