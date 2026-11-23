<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import { tasksQuery } from '#api/work.ts';
import type { TaskSummary } from '#api/types.ts';
import { parentGroupOf } from '#lib/work/parent-groups.ts';
import ParentHeadLine from '#components/work/ParentHeadLine.vue';
import IssueChip from '#components/ui/status/IssueChip.vue';
import StatusIcon from '#components/ui/status/StatusIcon.vue';
import TaskBadges from '#components/ui/status/TaskBadges.vue';

const props = defineProps<{ task: Pick<TaskSummary, 'id'> }>();
const tasksQ = useQuery(tasksQuery());
const group = computed(() => parentGroupOf(props.task, tasksQ.data.value ?? []));
</script>

<template>
  <article v-if="group" class="card" aria-label="Sub-issues" data-parent-card>
    <header class="card-head flex-wrap gap-2 px-3.5 py-2">
      <b>{{ group.label }}</b>
      <ParentHeadLine :head="group.head" />
    </header>
    <ol class="m-0 list-none py-1 pl-0">
      <li
        v-for="t in group.tasks"
        :key="t.id"
        class="flex min-w-0 items-center gap-2 px-3.5 py-1.5"
        :class="t.id === task.id && 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))]'"
        :aria-current="t.id === task.id ? 'true' : undefined"
      >
        <StatusIcon :task="t" />
        <IssueChip :issue="t.issue" />
        <RouterLink class="btn btn-ghost min-w-0 flex-1 truncate text-left hover:text-accent" :to="{ name: 'task', params: { id: t.id } }">
          {{ t.title }}
        </RouterLink>
        <TaskBadges :task="t" nowrap class="max-w-[45%] flex-none max-sm:hidden" />
        <span class="flex-none font-mono text-sm text-muted">#{{ t.id }}</span>
      </li>
    </ol>
  </article>
</template>
