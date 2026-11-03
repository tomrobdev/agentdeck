<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type PlanStep, type TaskPlan, ago, planHtmlQuery } from '../../api';
import { planProgress } from '../../../../daemon/src/domain/plan/plan.ts';
import { mode } from '../../platform/theme';
import { withBaseStyle } from '../../lib/planPage';
import planCss from '../../../../docs/plans/plan.css?raw';
import Disclosure from '../ui/Disclosure.vue';
import DisclosureContent from '../ui/DisclosureContent.vue';
import DisclosureTrigger from '../ui/DisclosureTrigger.vue';
import Progress from '../ui/Progress.vue';

// One plan attached to the task: its steps and how far they got, and the whole page on request.
// The page runs in a sandboxed frame with no scripts; same-origin only so we can size and scroll it.
const props = defineProps<{ taskId: number; plan: TaskPlan }>();
const emit = defineEmits<{ open: [path: string] }>();

const STEP_ICON: Record<PlanStep['status'], string> = { done: '✓', doing: '◐', todo: '○', blocked: '!', skipped: '–' };
const progress = computed(() => planProgress(props.plan.steps));
const finished = computed(() => progress.value.finished);
const total = computed(() => progress.value.total);
// What colour a step's icon (and "in progress" label) takes, and how its title looks, by status.
const ICON_TONE: Record<PlanStep['status'], string> = {
  done: 'text-done',
  doing: 'text-running',
  todo: 'text-muted',
  blocked: 'text-blocked',
  skipped: 'text-muted',
};
const STEP_TONE: Record<PlanStep['status'], string> = { done: '', doing: '', todo: '', blocked: '', skipped: 'text-muted line-through' };

// Where the plan came from. A plan this task follows may belong to another task, the one it was first attached to.
const SOURCE_LABEL: Record<TaskPlan['source'], string> = {
  attached: 'attached',
  worker: 'written by the worker',
  branch: 'from the branch',
};
const origin = computed(() => (props.plan.task_id === props.taskId ? SOURCE_LABEL[props.plan.source] : `#${props.plan.task_id}'s plan`));

const full = ref(false);
// Keyed by updated_at, so a run that rewrites the page reads it again, and only while it is showing. Read from the
// task the plan belongs to.
const pageQ = useQuery(
  computed(() => ({ ...planHtmlQuery(props.plan.task_id, props.plan.id, props.plan.updated_at), enabled: full.value })),
);
// Rebuilt when the mode changes, but only for a plan that follows it (the frame reloads, so it returns to the top):
// withBaseStyle reads the mode only for a plan that doesn't link plan.css.
const html = computed(() => (pageQ.data.value ? withBaseStyle(pageQ.data.value.html, mode.value, planCss) : null));
const error = computed(() => (pageQ.error.value ? `Couldn't load the plan: ${pageQ.error.value.message}` : ''));
const frame = ref<HTMLIFrameElement | null>(null);
let scrollTo: string | null = null;

// Show the whole plan, scrolled to a step. (The Read the plan button opens and closes it by itself.)
async function show(stepId: string) {
  const wasShowing = full.value;
  full.value = true;
  scrollTo = stepId;
  // A frame that is already up doesn't reload, so scroll it now; a new one scrolls when it loads.
  if (wasShowing && html.value !== null) await nextTick().then(onFrameLoad);
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
  <Disclosure v-model:open="full" as="article" class="card">
    <header class="card-head items-baseline px-3.5 py-2">
      <b>Plan</b>
      <span class="min-w-0 flex-1 truncate">{{ plan.title }}</span>
      <span
        v-if="total"
        class="flex items-center gap-1.5 text-sm text-muted tabular-nums"
        :title="`${finished} of ${total} steps done or skipped`"
      >
        <Progress
          label="Steps done or skipped"
          :value="finished"
          :max="total"
          indicator-class="bg-done"
          class="h-1.5 w-20 overflow-hidden rounded-[3px] bg-border"
        />
        {{ finished }}/{{ total }}
      </span>
    </header>
    <p v-if="plan.summary" class="m-0 px-3.5 pt-2.5">{{ plan.summary }}</p>
    <ol v-if="plan.steps.length" class="m-0 list-none px-3.5 py-2">
      <Disclosure v-for="(s, i) in plan.steps" :key="i" v-slot="{ open }" as="li" class="py-[3px]">
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
          <DisclosureTrigger v-if="s.done.length" class="btn-ghost ml-auto text-sm text-muted hover:text-accent">
            {{ open ? '▾' : '▸' }} {{ s.done.length }} {{ s.done.length === 1 ? 'check' : 'checks' }}
          </DisclosureTrigger>
        </div>
        <DisclosureContent>
          <ul class="m-0 list-none py-1 pl-[22px] text-sm text-muted">
            <li v-for="(c, j) in s.done" :key="j" class="py-px">☐ {{ c }}</li>
          </ul>
        </DisclosureContent>
      </Disclosure>
    </ol>
    <footer class="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2 text-sm">
      <DisclosureTrigger class="px-2 py-0 text-sm">{{ full ? 'Hide the plan' : 'Read the plan' }}</DisclosureTrigger>
      <button v-if="plan.source === 'branch'" class="px-2 py-0 text-sm" @click="emit('open', plan.name)">Open file</button>
      <span class="ml-auto text-muted">
        <code>{{ plan.name }}</code> · {{ origin }} · updated {{ ago(plan.updated_at) }}
      </span>
    </footer>
    <DisclosureContent class="border-t border-border">
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
    </DisclosureContent>
  </Disclosure>
</template>
