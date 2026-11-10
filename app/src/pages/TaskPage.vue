<script setup lang="ts">
import { computed, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { tasksQuery, taskQuery } from '../api/work';
import StaleDaemonBar from '../components/layout/StaleDaemonBar.vue';
import TaskView from '../components/work/task/TaskView.vue';
import { useActions } from '../composables/shared/useActions';
import { usePause } from '../composables/shared/usePause';
import { selectedId } from '../composables/shared/useShell';
import { useApprovals } from '../composables/work/useApprovals';
import { useTaskActs } from '../composables/work/usePaletteCommands';
import type { TaskTab } from '../lib/shared/app-url';

const props = defineProps<{ id: number; tab: TaskTab; query: Record<string, string> }>();
const { status } = usePause();
const taskQ = useQuery(computed(() => taskQuery(props.id)));
const tasksQ = useQuery(tasksQuery());
const { actOn } = useTaskActs(() => tasksQ.data.value ?? [], useActions(), useApprovals());
watch(
  () => props.id,
  (id) => (selectedId.value = id),
  { immediate: true },
);
</script>

<template>
  <main class="flex min-h-0 flex-1 flex-col">
    <StaleDaemonBar :status="status" />
    <TaskView
      v-if="taskQ.data.value"
      :key="taskQ.data.value.id"
      :task="taskQ.data.value"
      :tab="tab"
      :query="query"
      @act="(kind) => actOn(kind, taskQ.data.value!.id)"
    />
    <section v-else class="text-muted flex flex-1 flex-col items-center justify-center gap-3">Loading task #{{ id }}…</section>
  </main>
</template>
