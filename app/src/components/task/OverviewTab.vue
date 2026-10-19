<script setup lang="ts">
import { computed, ref } from 'vue';
import { type Changes, type Run, type TaskDetail, type TaskEventRow, ago, fmtTokens, runDuration, totalTokens } from '../../api';
import Markdown from '../files/Markdown.vue';
import DocumentsCard from './DocumentsCard.vue';
import PlanCard from './PlanCard.vue';

// The prompt as the description, then everything that happened, oldest first: status changes
// (task_events) and runs. Runs stand in for claim and finish events, which they describe better.
const props = defineProps<{ task: TaskDetail; changes: Changes | null; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ run: [attempt: number]; path: [path: string, line: number | null] }>();

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
  rate_limited: () => 'hit the usage limit; back in the queue without using an attempt',
  recover: (e) => (e.to_status === 'failed' ? 'failed after repeated daemon restarts' : 'requeued after a daemon restart'),
};

const items = computed<Item[]>(() => {
  const events = props.task.events ?? [];
  const out: Item[] = [];
  const created = events.find((e) => e.type === 'created');
  out.push({ kind: 'created', at: created?.at ?? props.task.created_at });
  for (const ev of events) if (EVENT_TEXT[ev.type]) out.push({ kind: 'event', at: ev.at, ev });
  const last = props.task.runs.at(-1)?.attempt;
  for (const run of props.task.runs) out.push({ kind: 'run', at: run.started_at, run, latest: run.attempt === last });
  return out.sort((a, b) => a.at.localeCompare(b.at));
});

const outcomeClass = (r: Run) => `s-${r.outcome ?? 'running'}`;
</script>

<template>
  <div class="overview">
    <article class="box">
      <header class="bhead">
        <b>{{ task.source === 'planner' ? 'Planner' : 'You' }}</b>
        <span class="muted">wrote the prompt {{ ago(task.created_at) }}</span>
      </header>
      <div class="bbody" :class="{ clamp: longPrompt && !promptOpen }">
        <Markdown :text="task.prompt" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
      </div>
      <button v-if="longPrompt" class="more" @click="promptOpen = !promptOpen">{{ promptOpen ? 'Show less' : 'Show all' }}</button>
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

    <ol class="timeline">
      <li v-for="(it, i) in items" :key="i" class="item" :class="it.kind === 'run' ? outcomeClass(it.run) : ''">
        <template v-if="it.kind === 'created'">
          <span class="node">○</span>
          <span
            ><b>{{ task.source === 'planner' ? 'The planner' : 'You' }}</b> created this task</span
          >
          <span class="when muted">{{ ago(it.at) }}</span>
        </template>
        <template v-else-if="it.kind === 'event'">
          <span class="node">{{ it.ev.type === 'retry' ? '↻' : it.ev.type === 'approve' ? '✓' : '•' }}</span>
          <span>
            {{ EVENT_TEXT[it.ev.type](it.ev) }}
            <span v-if="it.ev.reason" class="muted"> · {{ it.ev.reason }}</span>
          </span>
          <span class="when muted">{{ ago(it.at) }}</span>
        </template>
        <template v-else>
          <div class="runrow">
            <span class="node dot" />
            <button class="runlink" @click="emit('run', it.run.attempt)">Run {{ it.run.attempt }}</button>
            <span class="outcome">{{ it.run.outcome ?? 'running' }}</span>
            <span class="muted">
              · {{ runDuration(it.run) }}
              <template v-if="it.run.num_turns"> · {{ it.run.num_turns }} turns</template>
              <template v-if="totalTokens(it.run)"> · {{ fmtTokens(totalTokens(it.run)) }} tokens</template>
              <template v-if="it.run.tests_passed !== null"> · tests {{ it.run.tests_passed ? 'passed' : 'failed' }}</template>
              <template v-if="it.run.denials"> · {{ it.run.denials }} refused</template>
            </span>
            <span class="when muted">{{ ago(it.at) }}</span>
          </div>
          <details v-if="it.run.result_text" class="final" :open="it.latest">
            <summary>Final message</summary>
            <Markdown :text="it.run.result_text" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
          </details>
        </template>
      </li>
      <li v-if="task.pr_url" class="item">
        <span class="node">⎇</span>
        <span>Pull request {{ task.pr_state ?? 'open' }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.box {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.bhead {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--border);
}
.bbody {
  padding: 12px 14px;
}
.bbody.clamp {
  max-height: 320px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 70%, transparent);
}
.more {
  border: none;
  border-top: 1px solid var(--border);
  border-radius: 0;
  width: 100%;
  background: none;
  color: var(--accent);
  padding: 6px;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 10px;
  border-left: 2px solid var(--border);
  margin-left: 12px;
}
.item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 8px 0 8px 16px;
  position: relative;
}
.node {
  position: absolute;
  left: -21px;
  top: 7px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--muted);
  font-size: 12px;
}
.node.dot::after {
  content: '';
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--c, var(--running));
}
.runrow {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  width: 100%;
}
.runlink {
  border: none;
  background: none;
  padding: 0;
  font-weight: 600;
}
.runlink:hover {
  color: var(--accent);
}
.outcome {
  color: var(--c, var(--running));
  font-weight: 500;
}
.when {
  margin-left: auto;
  font-size: 12px;
}
.final {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 8px 14px;
}
.final summary {
  cursor: pointer;
  color: var(--muted);
}
.final[open] summary {
  margin-bottom: 8px;
}
</style>
