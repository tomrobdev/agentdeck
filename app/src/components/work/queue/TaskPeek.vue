<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type PersonEvent, planProgress, promptGoal } from '#daemon/domain/work/index.ts';
import { describeWait } from '#lib/work/work-wording.ts';
import { taskQuery } from '#api/work.ts';
import type { PlanStep } from '#api/types.ts';
import { linkParts, modelLine, neededBy, ownSteps, peekActions, peekProps } from '#lib/work/queue/peek.ts';
import { readNeeds, readTaskQuestion } from '#lib/work/task-view.ts';
import Markdown from '#components/ui/Markdown.vue';
import FinalMessage from '#components/runs/FinalMessage.vue';
import LogView from '#components/runs/LogView.vue';
import ProposalCheckCard from '#components/work/overview/ProposalCheckCard.vue';
import PullRequestCard from '#components/landing/PullRequestCard.vue';
import QuestionCallout from '#components/work/overview/QuestionCallout.vue';
import RunSummaryCard from '#components/runs/RunSummaryCard.vue';
import StatusPill from '#components/ui/status/StatusPill.vue';
import TaskBadges from '#components/ui/status/TaskBadges.vue';
import TaskStatusLine from '#components/ui/status/TaskStatusLine.vue';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ open: []; close: []; act: [kind: PersonEvent, id: number]; merge: [id: number]; peek: [id: number] }>();

const q = useQuery(computed(() => taskQuery(props.id)));
const task = computed(() => q.data.value ?? null);
const needs = computed(() => (task.value ? readNeeds(task.value) : null));
const question = computed(() => (task.value ? readTaskQuestion(task.value) : null));
const latestRun = computed(() => task.value?.runs.at(-1) ?? null);
const lastWorkRun = computed(() => task.value?.runs.findLast((r) => r.kind === 'work') ?? null);
const model = computed(() => (task.value ? modelLine(task.value, lastWorkRun.value?.model_id ?? null) : null));
const properties = computed(() => (task.value ? peekProps(task.value) : []));
const links = computed(() => (task.value ? linkParts(task.value.links) : []));
const needed = computed(() => (task.value ? neededBy(task.value.dependents) : []));
const goal = computed(() => (task.value ? promptGoal(task.value.prompt) : ''));
const actions = computed(() => (task.value ? peekActions(task.value) : []));
const stopped = computed(() => task.value?.status === 'blocked' || task.value?.status === 'failed');
const failedRun = computed(() => task.value?.runs.findLast((r) => r.summary) ?? null);
const waitText = computed(() => (task.value?.status === 'queued' ? (task.value.wait ? describeWait(task.value.wait) : null) : null));
const plans = computed(() =>
  (task.value?.plans ?? []).map((p) => ({
    plan: p,
    progress: planProgress(p.steps),
    steps: ownSteps(p.steps, task.value?.plan_steps ?? null),
  })),
);

const STEP_ICON: Record<PlanStep['status'], string> = { done: '✓', doing: '◐', todo: '○', blocked: '!', skipped: '–' };
const ACTION_LABEL = { approve: '✓ Approve', reject: 'Reject', retry: '↻ Retry', merge: 'Merge', cancel: 'Cancel' } as const;
const ACTION_KEY: Record<string, string> = { approve: ' (a)', retry: ' (r)', merge: ' (m)' };
const LINK_TONE = { met: 'text-done', waiting: 'text-muted', stuck: 'text-blocked', unlanded: 'text-blocked' } as const;

function act(kind: (typeof actions.value)[number]) {
  if (kind === 'merge') emit('merge', props.id);
  else emit('act', kind, props.id);
}
</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-bg p-4" aria-label="Task preview">
    <p v-if="!task" class="text-muted">Loading task #{{ id }}…</p>
    <template v-else>
      <header class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h2 class="text-lg wrap-anywhere">{{ task.title }}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <StatusPill :task="task" />
            <span class="text-muted">#{{ task.id }} · {{ task.repo }}</span>
            <TaskBadges :task="task" />
          </div>
          <TaskStatusLine :task="task" fit="full" class="mt-1.5" />
        </div>
        <div class="flex flex-none flex-wrap justify-end gap-1.5" data-peek-actions>
          <button
            v-for="a in actions"
            :key="a"
            :class="{ primary: a === 'approve' }"
            :title="`${ACTION_LABEL[a].replace(/^\S+ (?=\S)/, '')}${ACTION_KEY[a] ?? ''}`"
            :data-peek-action="a"
            @click="act(a)"
          >
            {{ ACTION_LABEL[a] }}
          </button>
          <button title="Open the full page (Enter)" @click="emit('open')">Open</button>
          <button title="Close (Esc)" @click="emit('close')">✕</button>
        </div>
      </header>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-peek-props>
        <span :title="model?.title" data-peek-model><span class="text-muted">Model</span> {{ model?.text }}</span>
        <span v-for="p in properties" :key="p.label"
          ><span class="text-muted">{{ p.label }}</span> {{ p.text }}</span
        >
      </div>

      <p v-if="links.length || needed.length" class="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm" data-peek-links>
        <template v-for="(l, i) in links" :key="l.id">
          <span v-if="i" class="text-muted">·</span>
          <button class="btn-ghost p-0 hover:text-accent" :class="LINK_TONE[l.state]" @click="emit('peek', l.id)">{{ l.text }}</button>
        </template>
        <template v-if="needed.length">
          <span v-if="links.length" class="text-muted">·</span>
          <span class="text-muted">needed by</span>
          <button v-for="n in needed" :key="n" class="btn-ghost p-0 font-mono hover:text-accent" @click="emit('peek', n)">#{{ n }}</button>
        </template>
      </p>

      <section v-for="p in plans" :key="p.plan.id" class="card" aria-label="Plan" data-peek-plan>
        <header class="card-head items-baseline gap-2 px-3.5 py-2">
          <b>Plan</b>
          <span class="min-w-0 flex-1 truncate">{{ p.plan.title }}</span>
          <span class="text-sm text-muted tabular-nums">{{ p.progress.finished }}/{{ p.progress.total }} steps done</span>
        </header>
        <ul v-if="p.steps.length" class="m-0 list-none px-3.5 py-2 text-sm">
          <li v-for="(s, i) in p.steps" :key="s.id ?? i" class="flex items-baseline gap-2 py-px">
            <span class="w-3.5 text-center" :title="s.status">{{ STEP_ICON[s.status] }}</span>
            <span :class="s.status === 'skipped' ? 'text-muted line-through' : ''">{{ s.title }}</span>
          </li>
        </ul>
      </section>

      <section v-if="goal" class="card" aria-label="Goal" data-peek-goal>
        <div class="max-h-40 overflow-hidden px-3.5 py-2.5 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
          <Markdown :text="goal" />
        </div>
        <button class="w-full rounded-none border-0 border-t border-border bg-transparent p-1.5 text-accent" @click="emit('open')">
          More
        </button>
      </section>

      <div v-if="needs" class="callout s-blocked">Needs {{ needs.kind }}: {{ needs.items.join(' ') }}</div>

      <ProposalCheckCard :task="task" />

      <p v-if="task.status === 'queued'" class="m-0 text-sm text-muted" data-peek-wait>
        {{ waitText ?? 'Nothing makes it wait: it starts when a slot is free, by priority.' }}
      </p>

      <template v-if="stopped">
        <QuestionCallout v-if="question" :task="task" :question="question" />
        <RunSummaryCard v-if="failedRun?.summary" :summary="failedRun.summary" />
        <p v-if="task.stop_reason" class="callout s-failed m-0 wrap-anywhere">{{ task.stop_reason }}</p>
      </template>

      <template v-if="task.status === 'done'">
        <p v-if="task.auto_merge_view" class="m-0 text-sm" data-peek-auto-merge>
          <b>{{ task.auto_merge_view.label }}</b>
          <template v-if="task.auto_merge_view.reasons.length"> · {{ task.auto_merge_view.reasons.join(' · ') }}</template>
        </p>
        <FinalMessage v-if="latestRun?.result_text" :open="false">
          <Markdown :text="latestRun.result_text" />
        </FinalMessage>
      </template>

      <PullRequestCard :task="task" />

      <div v-if="task.status === 'running'" class="flex min-h-[240px] flex-1 flex-col">
        <LogView :task-id="task.id" :run-id="latestRun?.id ?? null" live :worktree="task.worktree" />
      </div>
    </template>
  </aside>
</template>
