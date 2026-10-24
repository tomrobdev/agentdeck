<script setup lang="ts">
import { computed, ref } from 'vue';
import { type Changes, type Run, type TaskDetail, type TaskEventRow, ago, fmtTokens, runDuration, totalTokens } from '../../api';
import Markdown from '../files/Markdown.vue';
import DocumentsCard from './DocumentsCard.vue';
import FinalMessage from './FinalMessage.vue';
import PlanCard from './PlanCard.vue';

// The prompt as the description, then everything that happened, oldest first: status changes
// (task_events) and runs. Runs stand in for claim and finish events, which they describe better.
const props = defineProps<{ task: TaskDetail; changes: Changes | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ run: [runId: number]; path: [path: string, line: number | null] }>();

const promptOpen = ref(false);
const longPrompt = computed(() => props.task.prompt.length > 900 || props.task.prompt.split('\n').length > 18);

type Item =
  | { kind: 'event'; at: string; ev: TaskEventRow }
  | { kind: 'created'; at: string }
  | { kind: 'run'; at: string; run: Run; latest: boolean };

const EVENT_TEXT: Record<string, (e: TaskEventRow) => string> = {
  approve: () => 'approved the proposal',
  reject: () => 'rejected the proposal',
  retry: (e) => (e.reason ? 'requested changes' : 'queued another attempt'),
  cancel: (e) => (e.to_status === 'cancel_requested' ? 'asked the run to stop' : 'cancelled the task'),
  merge: () => 'merged the pull request',
  sync: (e) => e.reason ?? 'brought the base branch into the branch',
  conflict: () => 'could not resolve conflicts with the base branch; blocked',
  rate_limited: () => 'hit the usage limit; back in the queue without using an attempt',
  recover: (e) => (e.to_status === 'failed' ? 'failed after repeated daemon restarts' : 'requeued after a daemon restart'),
};

const items = computed<Item[]>(() => {
  const events = props.task.events ?? [];
  const out: Item[] = [];
  const created = events.find((e) => e.type === 'created');
  out.push({ kind: 'created', at: created?.at ?? props.task.created_at });
  for (const ev of events) if (EVENT_TEXT[ev.type]) out.push({ kind: 'event', at: ev.at, ev });
  const last = props.task.runs.at(-1)?.id;
  for (const run of props.task.runs) out.push({ kind: 'run', at: run.started_at, run, latest: run.id === last });
  return out.sort((a, b) => a.at.localeCompare(b.at));
});

const outcomeClass = (r: Run) => `s-${r.outcome ?? 'running'}`;

// A timeline entry, and the marker that sits on the line to its left.
const item = 'relative flex flex-wrap items-baseline gap-2 py-2 pr-0 pl-4';
const node = 'absolute top-[7px] -left-[21px] grid size-5 place-items-center rounded-full bg-bg text-sm text-muted';
const when = 'ml-auto text-sm text-muted';
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4.5">
    <article class="card">
      <header class="card-head gap-1.5 px-3.5 py-2">
        <b>{{ task.source === 'planner' ? 'Planner' : 'You' }}</b>
        <span class="text-muted">wrote the prompt {{ ago(task.created_at) }}</span>
      </header>
      <div
        class="px-3.5 py-3"
        :class="longPrompt && !promptOpen && 'max-h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'"
      >
        <Markdown :text="task.prompt" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
      </div>
      <button
        v-if="longPrompt"
        class="w-full rounded-none border-0 border-t border-border bg-transparent p-1.5 text-accent"
        @click="promptOpen = !promptOpen"
      >
        {{ promptOpen ? 'Show less' : 'Show all' }}
      </button>
    </article>

    <PlanCard v-for="p in task.plans ?? []" :key="p.id" :task-id="task.id" :plan="p" @open="(path) => emit('path', path, null)" />

    <DocumentsCard
      :task-id="task.id"
      :files="changes?.files ?? []"
      :head="changes?.head ?? null"
      :is-path="isPath"
      @open="(p) => emit('path', p, null)"
      @path="(p, l) => emit('path', p, l)"
    />

    <ol class="my-0 ml-3 list-none border-l-2 border-border pl-2.5">
      <li v-for="(it, i) in items" :key="i" :class="[item, it.kind === 'run' && outcomeClass(it.run)]">
        <template v-if="it.kind === 'created'">
          <span :class="node">○</span>
          <span
            ><b>{{ task.source === 'planner' ? 'The planner' : 'You' }}</b> created this task</span
          >
          <span :class="when">{{ ago(it.at) }}</span>
        </template>
        <template v-else-if="it.kind === 'event'">
          <span :class="node">{{ it.ev.type === 'retry' ? '↻' : it.ev.type === 'approve' ? '✓' : '•' }}</span>
          <span>
            {{ EVENT_TEXT[it.ev.type](it.ev) }}
            <span v-if="it.ev.reason && it.ev.type !== 'sync'" class="text-muted"> · {{ it.ev.reason }}</span>
          </span>
          <span :class="when">{{ ago(it.at) }}</span>
        </template>
        <template v-else>
          <div class="flex w-full flex-wrap items-baseline gap-1.5">
            <span :class="node" class="dot after:size-2.5 after:rounded-full after:bg-[var(--c,var(--running))]" />
            <button class="btn-ghost font-semibold hover:text-accent" @click="emit('run', it.run.id)">
              {{ it.run.kind === 'resolve' ? 'Resolve conflicts' : `Run ${it.run.attempt}` }}
            </button>
            <span class="font-medium text-[color:var(--c,var(--running))]">{{ it.run.outcome ?? 'running' }}</span>
            <span class="text-muted">
              · {{ runDuration(it.run) }}
              <template v-if="it.run.num_turns"> · {{ it.run.num_turns }} turns</template>
              <template v-if="totalTokens(it.run)"> · {{ fmtTokens(totalTokens(it.run)) }} tokens</template>
              <template v-if="it.run.tests_passed !== null"> · tests {{ it.run.tests_passed ? 'passed' : 'failed' }}</template>
              <template v-if="it.run.denials"> · {{ it.run.denials }} refused</template>
            </span>
            <span :class="when">{{ ago(it.at) }}</span>
          </div>
          <FinalMessage v-if="it.run.result_text" class="w-full" :open="it.latest">
            <Markdown :text="it.run.result_text" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
          </FinalMessage>
        </template>
      </li>
      <li v-if="task.pr_url" :class="item">
        <span :class="node">⎇</span>
        <span>Pull request {{ task.pr_state ?? 'open' }}</span>
      </li>
    </ol>
  </div>
</template>
