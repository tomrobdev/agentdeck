<script setup lang="ts">
import { computed, ref } from 'vue';
import { type MergeResult, type TaskDetail, api, describePrRetry } from '../../api';
import { canFixChecks, canOpenPr, canStartMerge, isReview, personEvents } from '../../lib/task/task-view';
import { useAction, useActions } from '../../composables/shared/useActions';
import { useOpenNext } from '../../composables/queue/useOpenNext';
import ConfirmDialog from '../ui/ConfirmDialog.vue';
import MarkDoneDialog from './merge/MarkDoneDialog.vue';
import MergeDialog from './merge/MergeDialog.vue';

// The buttons at the end of a task page's tab bar, and the dialogs some of them open. A sync or a merge request is on the
// header's status line, with Cancel merge.
const props = defineProps<{ task: TaskDetail }>();
const emit = defineEmits<{ act: [kind: 'approve' | 'reject' | 'retry' | 'cancel']; review: [] }>();
const { refresh, flash } = useActions();
const { pending, run } = useAction();

const events = computed(() => personEvents(props.task));

// Closing the PR asks first, because it closes it on GitHub. Request changes opens the review bar on the task page.
const closing = ref(false);
async function closePr() {
  if (pending.value) return;
  await run(() => api.closePr(props.task.id));
  closing.value = false;
}

// Send the PR's failing checks back to the worker; a refusal is flashed with the API's wording.
async function fixChecks() {
  if (pending.value) return;
  await run(() => api.fixChecks(props.task.id));
}

// Open a done task's PR that failed to open, or was closed; a refusal or gh's error is flashed with the API's wording.
async function openPr() {
  if (pending.value) return;
  await run(() => api.openPr(props.task.id));
}

// Mark a blocked or failed task done by hand, with an optional note for the timeline.
const markingDone = ref(false);
async function submitMarkDone(doneNote: string) {
  if (pending.value) return;
  await run(() => api.markDone(props.task.id, doneNote));
  markingDone.value = false;
}

const merging = ref(false);
const { nextAfter, openNext } = useOpenNext();
async function onMerged(result: MergeResult, next: boolean) {
  merging.value = false;
  if (next) openNext(props.task.id);
  await refresh();
  if (result.cleanup_error) flash(`Merged, but cleanup failed: ${result.cleanup_error}`);
}
function onRequested(next: boolean) {
  merging.value = false;
  if (next) openNext(props.task.id);
}
</script>

<template>
  <div class="flex flex-none gap-1.5">
    <template v-if="events.includes('approve')">
      <button @click="emit('act', 'reject')">Reject</button>
      <button class="primary" @click="emit('act', 'approve')">✓ Approve</button>
    </template>
    <template v-if="isReview(task)">
      <button @click="closing = true">Close PR</button>
      <button @click="emit('review')">↻ Request changes</button>
    </template>
    <button v-else-if="events.includes('retry')" @click="emit('act', 'retry')">↻ Retry</button>
    <button v-if="canFixChecks(task)" :disabled="pending" @click="fixChecks">Fix failing checks</button>
    <button
      v-if="canOpenPr(task)"
      :class="{ primary: task.pr_retry?.state === 'person' }"
      :disabled="pending"
      :title="task.pr_retry ? describePrRetry(task.pr_retry) : 'Push the branch and open the PR again'"
      @click="openPr"
    >
      Open PR
    </button>
    <button v-if="events.includes('mark_done')" @click="markingDone = true">✓ Mark done</button>
    <button
      v-if="isReview(task)"
      class="primary"
      :disabled="!canStartMerge(task)"
      :title="task.sync ? 'Merge waits for the sync to end' : task.merge_request ? 'A merge is already requested' : undefined"
      @click="merging = true"
    >
      Merge PR
    </button>
    <button v-if="events.includes('cancel')" @click="emit('act', 'cancel')">{{ task.status === 'running' ? '■ Stop' : '✕ Cancel' }}</button>
  </div>

  <MarkDoneDialog v-if="markingDone" :task="task" with-note :busy="pending" @close="markingDone = false" @confirm="submitMarkDone" />
  <MergeDialog
    v-if="merging"
    :task-id="task.id"
    :has-next="!!nextAfter(task.id)"
    @close="merging = false"
    @merged="onMerged"
    @requested="onRequested"
  />

  <ConfirmDialog
    v-if="closing"
    title="Close pull request"
    confirm-label="Close PR"
    focus="cancel"
    :busy="pending"
    @cancel="closing = false"
    @confirm="closePr"
  >
    <p>
      Close the pull request for #{{ task.id }} on GitHub without merging it? Tasks waiting on this one will stay stuck until it is retried
      or they are cancelled.
    </p>
    <p>
      <a :href="task.pr_url ?? ''" target="_blank" rel="noreferrer">{{ task.pr_url }}</a>
    </p>
  </ConfirmDialog>
</template>
