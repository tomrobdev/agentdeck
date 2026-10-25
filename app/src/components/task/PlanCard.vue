<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { type PlanStep, type TaskPlan, ago, api } from '../../api';
import { type ModeKey, mode } from '../../platform/theme';

// One plan attached to the task: its steps and how far they got, and the whole page on request.
// The page runs in a sandboxed frame with no scripts; same-origin only so we can size and scroll it.
const props = defineProps<{ taskId: number; plan: TaskPlan }>();
const emit = defineEmits<{ open: [path: string] }>();

const STEP_ICON: Record<PlanStep['status'], string> = { done: '✓', doing: '◐', todo: '○', blocked: '!', skipped: '–' };
const finished = computed(() => props.plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length);
const total = computed(() => props.plan.steps.length);
// What colour a step's icon (and "in progress" label) takes, and how its title looks, by status.
const ICON_TONE: Record<PlanStep['status'], string> = {
  done: 'text-done',
  doing: 'text-running',
  todo: 'text-muted',
  blocked: 'text-blocked',
  skipped: 'text-muted',
};
const STEP_TONE: Record<PlanStep['status'], string> = { done: '', doing: '', todo: '', blocked: '', skipped: 'text-muted line-through' };

// Readable defaults for a plan that brings no styles of its own. Put first in <head>, so a plan's own CSS wins.
// The dashboard's mode decides the colour scheme: a plan follows the system only when the dashboard does.
function baseStyle(m: ModeKey) {
  const scheme = m === 'system' ? 'light dark' : m;
  return `<style>
:root { color-scheme: ${scheme}; }
body { margin: 0; padding: 16px 20px; background: Canvas; color: CanvasText; font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
h1 { font-size: 1.5em; } h2 { font-size: 1.15em; margin-top: 1.4em; }
code, pre { font-family: ui-monospace, Menlo, monospace; }
</style>`;
}
function withBaseStyle(page: string, m: ModeKey) {
  const style = baseStyle(m);
  const head = /<head[^>]*>/i.exec(page);
  if (head) return page.slice(0, head.index + head[0].length) + style + page.slice(head.index + head[0].length);
  return page.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + style);
}

// Steps whose done criteria are showing, by position.
const open = ref(new Set<number>());
function toggle(i: number) {
  const next = new Set(open.value);
  if (!next.delete(i)) next.add(i);
  open.value = next;
}

const full = ref(false);
const page = ref<string | null>(null);
// Rebuilt when the mode changes, so the open plan switches at once (the frame reloads, so it returns to the top).
const html = computed(() => (page.value === null ? null : withBaseStyle(page.value, mode.value)));
const error = ref('');
const frame = ref<HTMLIFrameElement | null>(null);
let scrollTo: string | null = null;

async function load() {
  try {
    page.value = (await api.planHtml(props.taskId, props.plan.id)).html;
    error.value = '';
  } catch (e) {
    error.value = `Couldn't load the plan: ${(e as Error).message}`;
  }
}
// The page changed (a run rewrote it): drop the old copy, and reload it if it's showing.
watch(
  () => [props.plan.id, props.plan.updated_at],
  () => {
    page.value = null;
    if (full.value) load();
  },
);

async function show(stepId: string | null = null) {
  full.value = stepId ? true : !full.value;
  if (!full.value) return;
  scrollTo = stepId;
  if (page.value === null) await load();
  else await nextTick().then(onFrameLoad);
}

function onFrameLoad() {
  const doc = frame.value?.contentDocument;
  if (!doc) return;
  const step = scrollTo && doc.getElementById(scrollTo);
  scrollTo = null;
  if (!step) return;
  // Scroll the frame alone (scrollIntoView would move the dashboard too), then show the frame.
  doc.defaultView?.scrollTo({ top: step.getBoundingClientRect().top + doc.defaultView.scrollY - 12 });
  frame.value!.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <article class="card">
    <header class="card-head items-baseline px-3.5 py-2">
      <b>Plan</b>
      <span class="min-w-0 flex-1 truncate">{{ plan.title }}</span>
      <span
        v-if="total"
        class="flex items-center gap-1.5 text-sm text-muted tabular-nums"
        :title="`${finished} of ${total} steps done or skipped`"
      >
        <span class="h-1.5 w-20 overflow-hidden rounded-[3px] bg-border"
          ><span class="block h-full bg-done" :style="{ width: `${(100 * finished) / total}%` }"
        /></span>
        {{ finished }}/{{ total }}
      </span>
    </header>
    <p v-if="plan.summary" class="m-0 px-3.5 pt-2.5">{{ plan.summary }}</p>
    <ol v-if="plan.steps.length" class="m-0 list-none px-3.5 py-2">
      <li v-for="(s, i) in plan.steps" :key="i" class="py-[3px]">
        <div class="flex items-baseline gap-2">
          <span class="w-3.5 text-center font-semibold" :class="ICON_TONE[s.status]" :title="s.status">{{ STEP_ICON[s.status] }}</span>
          <button
            v-if="s.id"
            class="btn-ghost text-left hover:text-accent"
            :class="STEP_TONE[s.status]"
            title="Show this step in the plan"
            @click="show(s.id)"
          >
            {{ s.title }}
          </button>
          <span v-else :class="STEP_TONE[s.status]">{{ s.title }}</span>
          <span v-if="s.status === 'doing' || s.status === 'blocked'" class="text-sm" :class="ICON_TONE[s.status]">{{
            s.status === 'doing' ? 'in progress' : 'blocked'
          }}</span>
          <button
            v-if="s.done.length"
            class="btn-ghost ml-auto text-sm text-muted hover:text-accent"
            :aria-expanded="open.has(i)"
            @click="toggle(i)"
          >
            {{ open.has(i) ? '▾' : '▸' }} {{ s.done.length }} {{ s.done.length === 1 ? 'check' : 'checks' }}
          </button>
        </div>
        <ul v-if="open.has(i)" class="m-0 list-none py-1 pl-[22px] text-sm text-muted">
          <li v-for="(c, j) in s.done" :key="j" class="py-px">☐ {{ c }}</li>
        </ul>
      </li>
    </ol>
    <footer class="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2 text-sm">
      <button class="px-2 py-0 text-sm" @click="show()">{{ full ? 'Hide the plan' : 'Read the plan' }}</button>
      <button v-if="plan.source === 'branch'" class="px-2 py-0 text-sm" @click="emit('open', plan.name)">Open file</button>
      <span class="ml-auto text-muted">
        <code>{{ plan.name }}</code> · {{ plan.source === 'branch' ? 'from the branch' : 'attached' }} · updated {{ ago(plan.updated_at) }}
      </span>
    </footer>
    <div v-if="full" class="border-t border-border">
      <p v-if="error" class="px-3.5 py-2 text-muted">{{ error }}</p>
      <p v-else-if="html === null" class="px-3.5 py-2 text-muted">Loading…</p>
      <iframe
        v-else
        ref="frame"
        class="block h-[70vh] w-full border-0 bg-bg"
        :srcdoc="html"
        sandbox="allow-same-origin"
        :title="plan.title"
        @load="onFrameLoad"
      />
    </div>
  </article>
</template>
