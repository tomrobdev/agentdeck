<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ago } from '#lib/shared/time.ts';
import { planHtmlQuery, workApi } from '#api/work.ts';
import type { PlanBranchView, PlanStep, TaskPlan } from '#api/types.ts';
import { useAction } from '#composables/shared/useActions.ts';
import { planProgress } from '#daemon/domain/work/index.ts';
import { plural } from '#daemon/domain/shared/index.ts';
import { mode } from '#platform/theme.ts';
import { openExternal } from '#platform/native.ts';
import { withBaseStyle } from '#lib/work/plan-page.ts';
import planCss from '#docs/plans/plan.css?raw';
import Disclosure from '#components/ui/disclosure/Disclosure.vue';
import DisclosureContent from '#components/ui/disclosure/DisclosureContent.vue';
import DisclosureTrigger from '#components/ui/disclosure/DisclosureTrigger.vue';
import Progress from '#components/ui/status/Progress.vue';

const props = defineProps<{ taskId: number; plan: TaskPlan; planBranch?: PlanBranchView | null; followed?: boolean }>();
const emit = defineEmits<{ open: [path: string] }>();
const { pending, run } = useAction();
const openPlanBranch = () =>
  run(() => workApi.openPlanBranch(props.plan.task_id), { done: `Opened a plan branch for #${props.plan.task_id}'s plan` });

const STEP_ICON: Record<PlanStep['status'], string> = { done: '✓', doing: '◐', todo: '○', blocked: '!', skipped: '–' };
const progress = computed(() => planProgress(props.plan.steps));
const finished = computed(() => progress.value.finished);
const total = computed(() => progress.value.total);
const ICON_TONE: Record<PlanStep['status'], string> = {
  done: 'text-done',
  doing: 'text-running',
  todo: 'text-muted',
  blocked: 'text-blocked',
  skipped: 'text-muted',
};
const STEP_TONE: Record<PlanStep['status'], string> = { done: '', doing: '', todo: '', blocked: '', skipped: 'text-muted line-through' };

const SOURCE_LABEL: Record<TaskPlan['source'], string> = {
  attached: 'attached',
  worker: 'written by the worker',
  branch: 'from the branch',
};
const origin = computed(() => (props.plan.task_id === props.taskId ? SOURCE_LABEL[props.plan.source] : `#${props.plan.task_id}'s plan`));

const full = ref(false);
const pageQ = useQuery(
  computed(() => ({ ...planHtmlQuery(props.plan.task_id, props.plan.id, props.plan.updated_at), enabled: full.value })),
);
const html = computed(() => (pageQ.data.value ? withBaseStyle(pageQ.data.value.html, mode.value, planCss) : null));
const error = computed(() => (pageQ.error.value ? `Couldn't load the plan: ${pageQ.error.value.message}` : ''));
const frame = ref<HTMLIFrameElement | null>(null);
let scrollTo: string | null = null;

async function show(stepId: string) {
  const wasShowing = full.value;
  full.value = true;
  scrollTo = stepId;
  if (wasShowing && html.value !== null) await nextTick().then(onFrameLoad);
}

function onFrameLoad() {
  const doc = frame.value?.contentDocument;
  if (!doc) return;
  const step = scrollTo && doc.getElementById(scrollTo);
  scrollTo = null;
  if (!step) return;
  doc.defaultView?.scrollTo({ top: step.getBoundingClientRect().top + doc.defaultView.scrollY - 12 });
  frame.value?.scrollIntoView({ block: 'nearest' });
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
            {{ open ? '▾' : '▸' }} {{ plural(s.done.length, 'check') }}
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
      <span v-if="planBranch" class="text-muted" :title="`Plan branch from ${planBranch.base}`" data-plan-branch>
        <code>{{ planBranch.name }}</code> · {{ planBranch.status }}
        <template v-if="planBranch.ahead !== null && planBranch.behind !== null">
          · {{ planBranch.ahead }} ahead, {{ planBranch.behind }} behind {{ planBranch.base }}
        </template>
        <template v-if="planBranch.pr_url">
          ·
          <button class="btn-ghost text-accent" @click="planBranch.pr_url && openExternal(planBranch.pr_url)">
            PR into {{ planBranch.base }} ↗
          </button>
        </template>
      </span>
      <button v-else-if="followed" class="px-2 py-0 text-sm" :disabled="pending" @click="openPlanBranch">Open a plan branch</button>
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
