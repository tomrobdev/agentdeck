<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { liveRunsQuery } from '#api/runs.ts';
import { KIND_NAMES } from '#lib/runs/run-wording.ts';

const emit = defineEmits<{ open: [id: number] }>();
const runsQ = useQuery(liveRunsQuery());
const runs = computed(() => runsQ.data.value ?? []);
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto p-4" data-running-view>
    <p v-if="!runs.length" class="text-muted">Nothing is running.</p>
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
      <button
        v-for="run in runs"
        :key="run.run_id"
        class="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-code-bg p-3 text-left"
        data-run-pane
        :aria-label="`#${run.task_id} ${run.title}`"
        @click="emit('open', run.task_id)"
      >
        <span class="truncate font-medium">#{{ run.task_id }} {{ run.title }}</span>
        <span class="text-muted flex flex-wrap gap-x-3 text-xs tabular-nums">
          <span>{{ KIND_NAMES[run.kind] }}</span>
          <span v-if="run.model">{{ run.model }}</span>
          <span data-run-turns>{{ run.turns }} of {{ run.max_turns }} turns</span>
          <span v-if="run.tool" data-run-tool>{{ run.tool }}</span>
        </span>
        <span v-if="run.lines.length" class="text-muted flex flex-col font-mono text-xs" data-run-lines>
          <span v-for="(line, i) in run.lines" :key="i" class="truncate">{{ line }}</span>
        </span>
        <span v-else class="text-muted text-xs">Waiting for output…</span>
      </button>
    </div>
  </div>
</template>
