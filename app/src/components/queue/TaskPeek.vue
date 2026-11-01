<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { taskQuery } from '../../api';
import { readNeeds, statusLabel } from '../../lib/taskView';
import LogView from '../task/LogView.vue';
import PullRequestCard from '../task/PullRequestCard.vue';
import StatusIcon from '../ui/StatusIcon.vue';

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
    <p v-if="!task" class="muted">Loading task #{{ id }}…</p>
    <template v-else>
      <header class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-lg wrap-anywhere">{{ task.title }}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
            <span
              class="inline-flex items-center gap-[5px] rounded-full bg-[color-mix(in_srgb,var(--c)_16%,var(--panel))] px-2.5 py-0.5 font-medium whitespace-nowrap text-status"
              :class="`s-${task.status}`"
              ><StatusIcon :task="task" :size="12" /> {{ statusLabel(task.status) }}</span
            >
            <span class="text-muted">#{{ task.id }} · {{ task.repo }}</span>
          </div>
        </div>
        <button title="Open the full page (Enter)" @click="emit('open')">Open</button>
        <button title="Close (Esc)" @click="emit('close')">✕</button>
      </header>

      <div v-if="needs" class="callout s-blocked">Needs {{ needs.kind }}: {{ needs.items.join(' ') }}</div>
      <div
        v-else-if="task.stop_reason && (task.status === 'blocked' || task.status === 'failed')"
        class="callout"
        :class="`s-${task.status}`"
      >
        {{ task.stop_reason }}
      </div>

      <PullRequestCard :task="task" />

      <div v-if="task.status === 'running'" class="flex min-h-[240px] flex-1 flex-col">
        <LogView :task-id="task.id" :run-id="latestRun" live :worktree="task.worktree" />
      </div>
    </template>
  </aside>
</template>
