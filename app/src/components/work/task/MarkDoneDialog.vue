<script setup lang="ts">
import { ref } from 'vue';
import type { TaskSummary } from '../../../api/types';
import { hasOpenPr } from '../../../../../daemon/src/domain/work/index.ts';
import ConfirmDialog from '../../ui/ConfirmDialog.vue';

const props = defineProps<{ task: Pick<TaskSummary, 'id' | 'title' | 'pr_url' | 'pr_state'>; withNote?: boolean; busy?: boolean }>();
const emit = defineEmits<{ close: []; confirm: [note: string] }>();

const note = ref('');
const prOpen = () => !!props.task.pr_url && hasOpenPr(props.task);
</script>

<template>
  <ConfirmDialog
    title="Mark done"
    confirm-label="Mark done"
    :focus="withNote ? 'field' : 'confirm'"
    :busy="busy"
    @cancel="emit('close')"
    @confirm="emit('confirm', note.trim())"
  >
    <p class="mt-0">
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
      @keydown.enter.meta.prevent="emit('confirm', note.trim())"
      @keydown.enter.ctrl.prevent="emit('confirm', note.trim())"
    />
  </ConfirmDialog>
</template>
