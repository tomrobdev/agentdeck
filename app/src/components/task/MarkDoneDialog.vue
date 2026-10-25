<script setup lang="ts">
import { ref } from 'vue';
import type { TaskSummary } from '../../api';
import { hasOpenPr } from '../../taskView';
import Modal from '../Modal.vue';

// Asks before a person says a blocked or failed task is done. The board asks without a note; the task page takes one.
const props = defineProps<{ task: Pick<TaskSummary, 'id' | 'title' | 'pr_url' | 'pr_state'>; withNote?: boolean; busy?: boolean }>();
const emit = defineEmits<{ close: []; confirm: [note: string] }>();

const note = ref('');
const prOpen = () => !!props.task.pr_url && hasOpenPr(props.task);
</script>

<template>
  <Modal title="Mark done" @close="emit('close')">
    <p>
      Mark #{{ task.id }} "{{ task.title }}" done by hand? Use this when you finished or landed the work yourself. It stays done even if its
      last run failed.
    </p>
    <p v-if="prOpen()" class="text-muted">
      Its pull request is still open, so tasks waiting on #{{ task.id }} wait for the merge.
      <a :href="task.pr_url ?? ''" target="_blank" rel="noreferrer">{{ task.pr_url }}</a>
    </p>
    <textarea
      v-if="withNote"
      v-model="note"
      class="w-full resize-y"
      rows="3"
      placeholder="Note for the timeline (optional)"
      autofocus
      @keydown.enter.meta.prevent="emit('confirm', note.trim())"
      @keydown.enter.ctrl.prevent="emit('confirm', note.trim())"
    />
    <div class="mt-3 flex justify-end gap-1.5">
      <button @click="emit('close')">Cancel</button>
      <button class="primary" :disabled="busy" @click="emit('confirm', note.trim())">Mark done</button>
    </div>
  </Modal>
</template>
