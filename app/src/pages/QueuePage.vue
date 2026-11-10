<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { reposQuery } from '../api/repos';
import { tasksQuery } from '../api/work';
import StaleDaemonBar from '../components/layout/StaleDaemonBar.vue';
import WaitBar from '../components/layout/WaitBar.vue';
import QueueView from '../components/work/queue/QueueView.vue';
import { useActions } from '../composables/shared/useActions';
import { openPanel, selectedId } from '../composables/shared/useShell';
import { usePause } from '../composables/shared/usePause';
import { useApprovals } from '../composables/work/useApprovals';
import { useTaskActs } from '../composables/work/usePaletteCommands';

const { status, pausing, resumeDaemon, resumeRepo } = usePause();
const tasksQ = useQuery(tasksQuery());
const reposQ = useQuery(reposQuery());
const tasks = computed(() => tasksQ.data.value ?? []);
const hasRepos = computed(() => (reposQ.data.value ?? []).length > 0);
const { actOn, openFromQueue } = useTaskActs(() => tasks.value, useActions(), useApprovals());
</script>

<template>
  <main class="flex min-h-0 flex-1 flex-col">
    <StaleDaemonBar :status="status" />
    <WaitBar :status="status" :busy="pausing" @resume="resumeDaemon" @resume-repo="resumeRepo" />
    <QueueView v-if="tasks.length" v-model:selected="selectedId" :tasks="tasks" @open="openFromQueue" @act="actOn" />
    <section v-else class="text-muted flex flex-1 flex-col items-center justify-center gap-3">
      No tasks yet.
      <button class="primary" @click="openPanel(hasRepos ? 'new' : 'repos')">
        {{ hasRepos ? 'Queue your first task' : 'Add a repo to get started' }}
      </button>
    </section>
  </main>
</template>
