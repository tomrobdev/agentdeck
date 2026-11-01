<script setup lang="ts">
import { computed } from 'vue';
import type { TaskDetail } from '../../api';
import { finalMessage } from '../../../../daemon/src/domain/pull-request/pr.ts';
import { openExternal } from '../../platform/native';
import Markdown from '../files/Markdown.vue';

// The pull request as it was opened: its state and link, and the summary the worker ended with (the PR body's first part).
const props = defineProps<{ task: TaskDetail; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ path: [path: string, line: number | null] }>();

const summary = computed(() => finalMessage(props.task.runs));
</script>

<template>
  <article v-if="task.pr_url" class="card">
    <header class="card-head gap-1.5 px-3.5 py-2">
      <b>Pull request</b>
      <span class="text-muted">{{ task.pr_state ?? 'open' }}</span>
      <button class="btn-ghost ml-auto text-accent" @click="openExternal(task.pr_url)">Open on GitHub ↗</button>
    </header>
    <div v-if="summary" class="px-3.5 py-3">
      <Markdown :text="summary" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
    </div>
  </article>
</template>
