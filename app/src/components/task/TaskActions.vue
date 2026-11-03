<script setup lang="ts">
import { computed, ref } from 'vue';
import { type MergeResult, type TaskDetail, api } from '../../api';
import { canReview, personEvents } from '../../lib/taskView';
import { useActions } from '../../composables/useActions';
import Modal from '../ui/Modal.vue';
import MarkDoneDialog from './MarkDoneDialog.vue';
import MergeDialog from './MergeDialog.vue';

// The buttons at the end of a task page's tab bar, and the dialogs some of them open. A sync or a merge request is on the
// header's status line, with Cancel merge.
const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ act: [kind: 'approve' | 'reject' | 'retry' | 'cancel']; review: [] }>();
const { busy, run, refresh, flash } = useActions();

const events = computed(() => personEvents(props.task));

// Closing the PR asks first, because it closes it on GitHub. Request changes opens the review bar on the task page.
const closing = ref(false);
async function closePr() {
  if (busy.value) return;
  await run(() => api.closePr(props.task.id));
  closing.value = false;
}

// Mark a blocked or failed task done by hand, with an optional note for the timeline.
const markingDone = ref(false);
async function submitMarkDone(doneNote: string) {
  if (busy.value) return;
  await run(() => api.markDone(props.task.id, doneNote));
  markingDone.value = false;
}

const merging = ref(false);
async function onMerged(result: MergeResult) {
  merging.value = false;
  await refresh();
  if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
}
</script>

<template>
  <div class="flex flex-none gap-1.5">
    <template v-if="events.includes('approve')">
      <button @click="emit('act', 'reject')">Reject</button>
      <button class="primary" @click="emit('act', 'approve')">✓ Approve</button>
    </template>
    <template v-if="canReview(task)">
      <button @click="closing = true">Close PR</button>
      <button @click="emit('review')">↻ Request changes</button>
    </template>
    <button v-else-if="events.includes('retry')" @click="emit('act', 'retry')">↻ Retry</button>
    <button v-if="events.includes('mark_done')" @click="markingDone = true">✓ Mark done</button>
    <button
      v-if="canReview(task)"
      class="primary"
      :disabled="!!task.sync || !!task.merge_request"
      :title="task.sync ? 'Merge waits for the sync to end' : task.merge_request ? 'A merge is already requested' : undefined"
      @click="merging = true"
    >
      Merge PR
    </button>
    <button v-if="events.includes('cancel')" @click="emit('act', 'cancel')">{{ task.status === 'running' ? '■ Stop' : '✕ Cancel' }}</button>
  </div>

  <MarkDoneDialog v-if="markingDone" :task="task" with-note :busy="busy" @close="markingDone = false" @confirm="submitMarkDone" />
  <MergeDialog v-if="merging" :task-id="task.id" @close="merging = false" @merged="onMerged" @requested="merging = false" />

  <Modal v-if="closing" title="Close pull request" @close="closing = false">
    <p>
      Close the pull request for #{{ task.id }} on GitHub without merging it? Tasks waiting on this one will stay stuck until it is retried
      or they are cancelled.
    </p>
    <p>
      <a :href="task.pr_url ?? ''" target="_blank" rel="noreferrer">{{ task.pr_url }}</a>
    </p>
    <div class="mt-3 flex justify-end gap-1.5">
      <button @click="closing = false">Cancel</button>
      <button class="primary" :disabled="busy" autofocus @click="closePr">Close PR</button>
    </div>
  </Modal>
</template>
