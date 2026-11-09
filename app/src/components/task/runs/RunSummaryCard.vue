<script setup lang="ts">
// A failed or blocked run summed up from its log: the verdict, its time and tools, its tests, and the last failing output.
import type { RunSummary } from '../../../api';

defineProps<{ summary: RunSummary }>();
</script>

<template>
  <section class="flex flex-col gap-1.5 rounded-md border border-border bg-panel px-3.5 py-2.5">
    <p class="font-semibold">{{ summary.verdict }}</p>
    <p class="flex flex-wrap gap-x-3 text-sm text-muted">
      <span
        >{{ summary.minutes }} min<template v-if="summary.test_runs">, {{ summary.test_minutes }} in tests</template></span
      >
      <span v-if="summary.test_runs">
        {{ summary.test_runs }} test {{ summary.test_runs === 1 ? 'run' : 'runs' }}, the last
        <span :class="summary.last_test === 'passed' ? 'text-done' : 'text-failed'">{{
          summary.last_test === 'passed' ? 'passing' : 'failing'
        }}</span>
      </span>
      <span v-if="summary.tools.length">{{ summary.tools.map((t) => `${t.name} ${t.count}`).join(' · ') }}</span>
      <span v-if="summary.refused" class="text-failed">{{ summary.refused }} refused</span>
    </p>
    <details v-if="summary.excerpt" open>
      <summary class="cursor-pointer text-sm text-muted">Last failure</summary>
      <pre class="my-1 max-h-50 overflow-auto text-sm whitespace-pre-wrap text-failed">{{ summary.excerpt }}</pre>
    </details>
  </section>
</template>
