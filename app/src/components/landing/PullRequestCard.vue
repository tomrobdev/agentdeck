<script setup lang="ts">
import { computed } from 'vue';
import { landingApi } from '../../api/landing';
import { checkDuration } from '../../lib/shared/time';
import type { PrCheck, TaskDetail } from '../../api/types';
import { failureHeadline, finalMessage } from '../../../../daemon/src/domain/landing/index.ts';
import { canFixChecks } from '../../lib/work/task-view';
import { useAction } from '../../composables/shared/useActions';
import { openExternal } from '../../platform/native';
import Markdown from '../ui/Markdown.vue';
import Tooltip from '../ui/Tooltip.vue';

const props = defineProps<{ task: TaskDetail; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ path: [path: string, line: number | null] }>();
const { pending, run } = useAction();

const summary = computed(() => finalMessage(props.task.runs));

const ORDER: Record<PrCheck['state'], number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };
const ICON: Record<PrCheck['state'], { icon: string; cls: string; label: string }> = {
  fail: { icon: '✗', cls: 'text-failed', label: 'failed' },
  pending: { icon: '●', cls: 'text-accent', label: 'running' },
  pass: { icon: '✓', cls: 'text-done', label: 'passed' },
  skipped: { icon: '–', cls: 'text-muted', label: 'skipped' },
};
const checks = computed(() =>
  props.task.pr_state === 'open'
    ? (props.task.check_list?.checks ?? [])
        .map((c, i) => ({ c, i }))
        .sort((a, b) => ORDER[a.c.state] - ORDER[b.c.state] || a.i - b.i)
        .map((x) => x.c)
    : [],
);
const fixable = computed(() => canFixChecks(props.task));

function failure(c: PrCheck): string | null {
  if (c.state !== 'fail') return null;
  const headline = c.excerpt ? failureHeadline(c.excerpt) : '';
  const what = headline || (c.excerpt_error ? `log not read: ${c.excerpt_error}` : '');
  if (!c.step && !what) return null;
  return [c.step, what].filter(Boolean).join(': ');
}

async function fixChecks() {
  if (pending.value) return;
  await run(() => landingApi.fixChecks(props.task.id));
}
</script>

<template>
  <article v-if="task.pr_url" class="card">
    <header class="card-head gap-1.5 px-3.5 py-2">
      <b>Pull request</b>
      <span class="text-muted">{{ task.pr_state ?? 'open' }}</span>
      <button class="btn-ghost ml-auto text-accent" @click="openExternal(task.pr_url)">Open on GitHub ↗</button>
    </header>
    <section v-if="checks.length" class="border-b border-border px-3.5 py-2.5" data-checks>
      <div class="mb-1.5 flex items-center gap-1.5">
        <b>Checks</b>
        <button v-if="fixable" class="ml-auto" :disabled="pending" @click="fixChecks">Fix failing checks</button>
      </div>
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        <li v-for="c in checks" :key="c.name" class="flex flex-col gap-1" :data-check-state="c.state">
          <div class="flex items-center gap-2">
            <Tooltip :text="`${c.name}\n${ICON[c.state].label}`">
              <span class="w-4 flex-none text-center" :class="ICON[c.state].cls" tabindex="0" :aria-label="ICON[c.state].label">{{
                ICON[c.state].icon
              }}</span>
            </Tooltip>
            <span class="min-w-0 flex-1 truncate" :title="c.name">{{ c.name }}</span>
            <span class="flex-none text-muted">{{ checkDuration(c) }}</span>
            <button v-if="c.url" class="btn-ghost flex-none text-accent" @click="openExternal(c.url)">↗</button>
          </div>
          <details v-if="failure(c)" class="ml-6 min-w-0" data-check-failure>
            <summary class="cursor-pointer truncate text-muted" :title="failure(c)!">› {{ failure(c) }}</summary>
            <pre v-if="c.excerpt" class="mt-1 max-h-72 overflow-auto rounded bg-code-bg p-2 text-xs whitespace-pre">{{ c.excerpt }}</pre>
            <div class="mt-1 flex gap-3">
              <button v-if="c.step_url" class="btn-ghost text-accent" @click="openExternal(c.step_url)">Open the step ↗</button>
              <button v-if="c.url" class="btn-ghost text-accent" @click="openExternal(c.url)">Open the job ↗</button>
            </div>
          </details>
        </li>
      </ul>
    </section>
    <div v-if="summary" class="px-3.5 py-3">
      <Markdown :text="summary" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
    </div>
  </article>
</template>
