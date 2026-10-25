<script setup lang="ts">
import { computed, ref } from 'vue';
import { type MergeResult, type TaskDetail, api } from '../../api';
import { canReview, personEvents } from '../../taskView';
import { useActions } from '../../useActions';
import Modal from '../Modal.vue';
import MarkDoneDialog from './MarkDoneDialog.vue';
import MergeDialog from './MergeDialog.vue';

// The buttons in a task page's header, and the dialogs some of them open.
const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ act: [kind: 'approve' | 'reject' | 'retry' | 'cancel'] }>();
const { busy, run, refresh, flash } = useActions();

const events = computed(() => personEvents(props.task));

// Review actions on a done task's open PR. Both ask first: one sends the task back, the other closes the PR on GitHub.
const reviewDialog = ref<'changes' | 'close' | null>(null);
const note = ref('');
function openReview(kind: 'changes' | 'close') {
  note.value = '';
  reviewDialog.value = kind;
}
async function submitReview() {
  const kind = reviewDialog.value;
  if (!kind || busy.value) return;
  const text = note.value.trim();
  if (kind === 'changes' && !text) return;
  await run(() => (kind === 'changes' ? api.retry(props.task.id, text) : api.closePr(props.task.id)));
  reviewDialog.value = null;
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
      <button @click="openReview('close')">Close PR</button>
      <button @click="openReview('changes')">↻ Request changes</button>
    </template>
    <button v-else-if="events.includes('retry')" @click="emit('act', 'retry')">↻ Retry</button>
    <button v-if="events.includes('mark_done')" @click="markingDone = true">✓ Mark done</button>
    <button v-if="canReview(task)" class="primary" @click="merging = true">Merge PR</button>
    <button v-if="events.includes('cancel')" @click="emit('act', 'cancel')">{{ task.status === 'running' ? '■ Stop' : '✕ Cancel' }}</button>
  </div>

  <MarkDoneDialog v-if="markingDone" :task="task" with-note :busy="busy" @close="markingDone = false" @confirm="submitMarkDone" />
  <MergeDialog v-if="merging" :task-id="task.id" @close="merging = false" @merged="onMerged" />

  <Modal v-if="reviewDialog === 'changes'" title="Request changes" @close="reviewDialog = null">
    <p class="text-muted">
      Sends #{{ task.id }} back for another attempt on the same branch. The note goes first in the next run's prompt and shows on the
      timeline.
    </p>
    <textarea
      v-model="note"
      class="w-full resize-y"
      rows="5"
      placeholder="What should change?"
      autofocus
      @keydown.enter.meta.prevent="submitReview"
      @keydown.enter.ctrl.prevent="submitReview"
    />
    <div class="mt-3 flex justify-end gap-1.5">
      <button @click="reviewDialog = null">Cancel</button>
      <button class="primary" :disabled="!note.trim() || busy" @click="submitReview">Request changes</button>
    </div>
  </Modal>
  <Modal v-if="reviewDialog === 'close'" title="Close pull request" @close="reviewDialog = null">
    <p>
      Close the pull request for #{{ task.id }} on GitHub without merging it? Tasks waiting on this one will stay stuck until it is retried
      or they are cancelled.
    </p>
    <p>
      <a :href="task.pr_url ?? ''" target="_blank" rel="noreferrer">{{ task.pr_url }}</a>
    </p>
    <div class="mt-3 flex justify-end gap-1.5">
      <button @click="reviewDialog = null">Cancel</button>
      <button class="primary" :disabled="busy" autofocus @click="submitReview">Close PR</button>
    </div>
  </Modal>
</template>
