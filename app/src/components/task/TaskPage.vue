<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import { type TaskDetail, ago, api, describeWait } from '../../api';
import { useHotkeys } from '../../hotkeys';
import { type TaskTab, go, openTask } from '../../router';
import { readNeeds, statusLabel } from '../../taskView';
import { useActions } from '../../useActions';
import { useChanges } from '../../useChanges';
import SnippetPopover from '../files/SnippetPopover.vue';
import StatusIcon from '../queue/StatusIcon.vue';
import ChangesTab from './ChangesTab.vue';
import CodeTab from './CodeTab.vue';
import NeedsCallout from './NeedsCallout.vue';
import OverviewTab from './OverviewTab.vue';
import RunsTab from './RunsTab.vue';
import Sidebar from './Sidebar.vue';
import TaskActions from './TaskActions.vue';
import TaskTitle from './TaskTitle.vue';

// A task laid out like a pull request: header, tabs, and a properties sidebar.
const props = defineProps<{ task: TaskDetail; tab: TaskTab; query: Record<string, string> }>();
const emit = defineEmits<{ act: [kind: 'approve' | 'reject' | 'retry' | 'cancel'] }>();
const { run } = useActions();

const pageEl = ref<HTMLElement | null>(null);

// End what this task waits for: resume the daemon or the repo.
const resumeDaemon = () => run(() => api.resume());
const resumeRepo = () => run(() => api.resumeRepo(props.task.repo_id));

const { changes, error: changesError, isPath, paths: knownPaths } = useChanges(toRef(props, 'task'));

const TABS = computed(() => [
  { key: 'overview' as const, label: 'Overview', count: null },
  { key: 'runs' as const, label: 'Runs', count: props.task.runs.length },
  { key: 'changes' as const, label: 'Files changed', count: changes.value?.files.length ?? null },
  { key: 'code' as const, label: 'Code', count: null },
]);
const wide = computed(() => props.tab === 'changes' || props.tab === 'code');

const runId = computed(() => (props.query.run ? Number(props.query.run) : null));
const openFile = (path: string, line: number | null = null) =>
  openTask(props.task.id, 'code', { ref: 'head', path, ...(line ? { L: String(line) } : {}) });

const s = computed(() => props.task.status);
const needs = computed(() => readNeeds(props.task));

// Dialogs hold the Escape key themselves (useHotkeys skips it while one is open).
useHotkeys({ Escape: () => go({ name: 'queue' }) });

// Branch names under the title.
const code = 'rounded-[5px] bg-[color-mix(in_srgb,var(--running)_10%,var(--panel))] px-1.5 py-px';
</script>

<template>
  <section ref="pageEl" class="flex min-h-0 flex-1 flex-col bg-bg">
    <SnippetPopover v-if="pageEl" :task-id="task.id" :root="pageEl" />
    <header class="flex items-start gap-3 px-6 pt-4 pb-2">
      <button class="mt-0.5" title="Back to the queue (Esc)" @click="go({ name: 'queue' })">←</button>
      <div class="min-w-0 flex-1">
        <TaskTitle :task="task" />
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-base">
          <span
            class="inline-flex items-center gap-[5px] rounded-full bg-[color-mix(in_srgb,var(--c)_16%,var(--panel))] px-2.5 py-0.5 font-medium whitespace-nowrap text-status text-sm"
            :class="`s-${task.status}`"
            ><StatusIcon :task="task" :size="12" /> {{ statusLabel(s) }}</span
          >
          <template v-if="task.branch">
            <code :class="code">{{ task.branch }}</code> <span class="text-muted">→</span>
            <code :class="code">{{ changes?.base_ref ?? 'base' }}</code>
          </template>
          <span class="text-muted">· {{ task.runs.length }} {{ task.runs.length === 1 ? 'run' : 'runs' }}</span>
          <span class="text-muted"
            >· {{ task.source === 'planner' ? 'proposed by the planner' : 'created' }} {{ ago(task.created_at) }}</span
          >
        </div>
      </div>
      <TaskActions :task="task" @act="(kind) => emit('act', kind)" />
    </header>

    <nav class="flex gap-0.5 border-b border-border px-6" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="-mb-px rounded-none border-0 border-b-2 bg-transparent px-3 py-2"
        role="tab"
        :aria-selected="tab === t.key"
        :class="tab === t.key ? 'border-accent font-semibold text-text' : 'border-transparent text-muted'"
        @click="openTask(task.id, t.key)"
      >
        {{ t.label }} <span v-if="t.count !== null" class="ml-0.5 rounded-full bg-panel-2 px-1.5 text-xs font-medium">{{ t.count }}</span>
      </button>
    </nav>

    <NeedsCallout v-if="needs" :task="task" :needs="needs" @retry="emit('act', 'retry')" />
    <div v-else-if="task.stop_reason && (s === 'blocked' || s === 'failed')" class="callout" :class="`s-${s}`">
      {{ task.stop_reason }}
    </div>
    <div v-else-if="task.wait" class="callout flex items-center gap-3" :class="task.wait.kind === 'slots' ? 's-queued' : 's-blocked'">
      <span class="min-w-0 flex-1 wrap-anywhere">
        <strong>Not started yet.</strong> {{ describeWait(task.wait) }}.
        <template v-if="task.wait.kind === 'dependency' && task.wait.stuck">
          Retry #{{ task.wait.on }} to release this task, or cancel it.
        </template>
      </span>
      <button v-if="task.wait.kind === 'daemon-paused'" class="primary" @click="resumeDaemon">▶ Resume</button>
      <button v-else-if="task.wait.kind === 'repo-paused'" class="primary" @click="resumeRepo">▶ Resume {{ task.repo }}</button>
      <button v-else-if="task.wait.kind === 'dependency'" @click="openTask(task.wait.on)">Open #{{ task.wait.on }}</button>
    </div>
    <div v-else-if="s === 'proposed'" class="callout s-proposed">
      The planner suggested this task. Read the prompt, then approve it to queue it or reject it.
    </div>

    <div class="flex min-h-0 flex-1 gap-7 px-6 pt-4 max-md:flex-col" :class="wide ? 'overflow-hidden pb-0' : 'overflow-y-auto pb-6'">
      <div class="flex min-w-0 flex-1 flex-col">
        <OverviewTab
          v-if="tab === 'overview'"
          :task="task"
          :changes="changes"
          :is-path="isPath"
          @run="(id) => openTask(task.id, 'runs', { run: String(id) })"
          @path="openFile"
        />
        <RunsTab
          v-else-if="tab === 'runs'"
          :task="task"
          :run-id="runId"
          :is-path="isPath"
          @select="(id) => go({ name: 'task', id: task.id, tab: 'runs', query: { run: String(id) } }, { replace: true })"
          @path="openFile"
        />
        <ChangesTab v-else-if="tab === 'changes'" :task="task" :changes="changes" :error="changesError" @open="openFile" />
        <CodeTab v-else :task="task" :query="query" :changed="knownPaths" />
      </div>
      <Sidebar v-if="!wide" :task="task" />
    </div>
  </section>
</template>
