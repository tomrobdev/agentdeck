<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { type PlanStep, type TaskPlan, ago, api } from '../../api';
import { type ModeKey, mode } from '../../theme';

// One plan attached to the task: its steps and how far they got, and the whole page on request.
// The page runs in a sandboxed frame with no scripts; same-origin only so we can size and scroll it.
const props = defineProps<{ taskId: number; plan: TaskPlan }>();
const emit = defineEmits<{ open: [path: string] }>();

const STEP_ICON: Record<PlanStep['status'], string> = { done: '✓', doing: '◐', todo: '○', blocked: '!', skipped: '–' };
const finished = computed(() => props.plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length);
const total = computed(() => props.plan.steps.length);

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
  <article class="plan">
    <header class="phead">
      <b>Plan</b>
      <span class="title">{{ plan.title }}</span>
      <span v-if="total" class="progress" :title="`${finished} of ${total} steps done or skipped`">
        <span class="bar"><span :style="{ width: `${(100 * finished) / total}%` }" /></span>
        {{ finished }}/{{ total }}
      </span>
    </header>
    <p v-if="plan.summary" class="summary">{{ plan.summary }}</p>
    <ol v-if="plan.steps.length" class="steps">
      <li v-for="(s, i) in plan.steps" :key="i" :class="`st-${s.status}`">
        <span class="icon" :title="s.status">{{ STEP_ICON[s.status] }}</span>
        <button v-if="s.id" class="step" title="Show this step in the plan" @click="show(s.id)">{{ s.title }}</button>
        <span v-else class="step">{{ s.title }}</span>
        <span v-if="s.status === 'doing' || s.status === 'blocked'" class="state">{{
          s.status === 'doing' ? 'in progress' : 'blocked'
        }}</span>
      </li>
    </ol>
    <footer class="pfoot">
      <button class="mini" @click="show()">{{ full ? 'Hide the plan' : 'Read the plan' }}</button>
      <button v-if="plan.source === 'branch'" class="mini" @click="emit('open', plan.name)">Open file</button>
      <span class="muted">
        <code>{{ plan.name }}</code> · {{ plan.source === 'branch' ? 'from the branch' : 'attached' }} · updated {{ ago(plan.updated_at) }}
      </span>
    </footer>
    <div v-if="full" class="page">
      <p v-if="error" class="muted pad">{{ error }}</p>
      <p v-else-if="html === null" class="muted pad">Loading…</p>
      <iframe v-else ref="frame" :srcdoc="html" sandbox="allow-same-origin" :title="plan.title" @load="onFrameLoad" />
    </div>
  </article>
</template>

<style scoped>
.plan {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.phead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 14px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.progress {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.bar {
  width: 80px;
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--done);
}
.summary {
  margin: 0;
  padding: 10px 14px 0;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 8px 14px;
}
.steps li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
}
.icon {
  width: 14px;
  text-align: center;
  color: var(--muted);
  font-weight: 600;
}
.st-done .icon {
  color: var(--done);
}
.st-doing .icon,
.st-doing .state {
  color: var(--running);
}
.st-blocked .icon,
.st-blocked .state {
  color: var(--blocked);
}
.st-skipped .step {
  color: var(--muted);
  text-decoration: line-through;
}
.step {
  border: none;
  background: none;
  padding: 0;
  text-align: left;
  font: inherit;
  color: inherit;
}
button.step:hover {
  color: var(--accent);
}
.state {
  font-size: 12px;
}
.pfoot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.pfoot .muted {
  margin-left: auto;
}
.mini {
  padding: 0 8px;
  font-size: 12px;
}
.page {
  border-top: 1px solid var(--border);
}
.pad {
  padding: 8px 14px;
}
iframe {
  display: block;
  width: 100%;
  height: 70vh;
  border: none;
  background: var(--bg);
}
</style>
