<script setup lang="ts">
import { landingApi } from '../../api/landing';
import type { TaskSummary } from '../../api/types';
import { useActions } from '../../composables/shared/useActions';
import { canStartMerge, isReview } from '../../../../daemon/src/domain/work/index.ts';

const props = defineProps<{ task: TaskSummary; sync?: boolean }>();
const emit = defineEmits<{ merge: [id: number]; sync: [id: number] }>();

const { run } = useActions();
const cancelMerge = () => run(() => landingApi.cancelMergeRequest(props.task.id));
</script>

<template>
  <button v-if="sync && task.sync" class="btn-mini" disabled>Syncing…</button>
  <template v-else-if="isReview(task)">
    <button
      v-if="sync"
      class="btn-mini"
      title="Sync the branch with the base branch; a conflict starts a claude run"
      @click="emit('sync', task.id)"
    >
      Sync
    </button>
    <button v-if="task.merge_request" class="btn-mini" title="Withdraw the merge request" @click="cancelMerge">Cancel merge</button>
    <button v-else-if="canStartMerge(task)" class="btn-mini" title="Merge (m)" @click="emit('merge', task.id)">Merge</button>
  </template>
</template>
