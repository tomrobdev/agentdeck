<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { taskQuery } from '../../api';
import { readNeeds } from '../../lib/taskView';
import LogView from '../task/LogView.vue';
import ProposalCheckCard from '../task/ProposalCheckCard.vue';
import PullRequestCard from '../task/PullRequestCard.vue';
import StatusPill from '../ui/StatusPill.vue';
import TaskBadges from '../ui/TaskBadges.vue';
import TaskStatusLine from '../ui/TaskStatusLine.vue';

// A read-only look at one task beside the list: what it is, why it stopped, its pull request, and a running task's live log.
const props = defineProps<{ id: number }>();
const emit = defineEmits<{ open: []; close: [] }>();

const q = useQuery(computed(() => taskQuery(props.id)));
const task = computed(() => q.data.value ?? null);
const needs = computed(() => (task.value ? readNeeds(task.value) : null));
const latestRun = computed(() => task.value?.runs.at(-1)?.id ?? null);
</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-bg p-4" aria-label="Task preview">
    <p v-if="!task" class="text-muted">Loading task #{{ id }}…</p>
    <template v-else>
      <header class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-lg wrap-anywhere">{{ task.title }}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <StatusPill :task="task" />
            <span class="text-muted">#{{ task.id }} · {{ task.repo }}</span>
            <TaskBadges :task="task" />
          </div>
          <TaskStatusLine :task="task" fit="full" class="mt-1.5" />
        </div>
        <button title="Open the full page (Enter)" @click="emit('open')">Open</button>
        <button title="Close (Esc)" @click="emit('close')">✕</button>
      </header>

      <div v-if="needs" class="callout s-blocked">Needs {{ needs.kind }}: {{ needs.items.join(' ') }}</div>

      <ProposalCheckCard :task="task" />

      <PullRequestCard :task="task" />

      <div v-if="task.status === 'running'" class="flex min-h-[240px] flex-1 flex-col">
        <LogView :task-id="task.id" :run-id="latestRun" live :worktree="task.worktree" />
      </div>
    </template>
  </aside>
</template>
