<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import { type TaskDetail, ago, api, describeWait } from '../../api';
import { useHotkeys } from '../../composables/useHotkeys';
import { type TaskTab, go, openTask } from '../../router';
import { readNeeds } from '../../lib/taskView';
import { useActions } from '../../composables/useActions';
import { useChanges } from '../../composables/useChanges';
import { useReviews } from '../../composables/useReviews';
import SnippetPopover from '../files/SnippetPopover.vue';
import StatusPill from '../ui/StatusPill.vue';
import TabBar from '../ui/TabBar.vue';
import TaskBadges from '../ui/TaskBadges.vue';
import TaskStatusLine from '../ui/TaskStatusLine.vue';
import ChangesTab from './ChangesTab.vue';
import CodeTab from './CodeTab.vue';
import NeedsCallout from './NeedsCallout.vue';
import OverviewTab from './OverviewTab.vue';
import ReviewBar from './ReviewBar.vue';
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

// The review bar shows while a draft has comments, or once Request changes was pressed.
const { draft, pending } = useReviews(computed(() => props.task.id));
const requesting = ref(false);
const showReviewBar = computed(() => requesting.value || pending.value > 0);
watch(
  () => props.task.id,
  () => (requesting.value = false),
);

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
const base = computed(() => changes.value?.base_ref ?? 'base');
const code = 'rounded-[5px] bg-[color-mix(in_srgb,var(--running)_10%,var(--panel))] px-1.5 py-px';
</script>

<template>
  <section ref="pageEl" class="flex min-h-0 flex-1 flex-col bg-bg">
    <SnippetPopover v-if="pageEl" :task-id="task.id" :root="pageEl" />
    <!-- Row 1 the number and title, full width; row 2 the status, branch and facts; row 3 the status line. -->
    <header class="flex items-start gap-3 px-6 pt-4 pb-3">
      <button class="mt-0.5" title="Back to the queue (Esc)" @click="go({ name: 'queue' })">←</button>
      <div class="min-w-0 flex-1">
        <TaskTitle :task="task" />
        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <StatusPill :task="task" />
          <span
            v-if="task.branch"
            class="inline-flex max-w-full min-w-0 items-center gap-1 whitespace-nowrap"
            :title="`${task.branch} → ${base}`"
            data-branch
          >
            <code :class="code" class="min-w-0 truncate">{{ task.branch }}</code>
            <span>→</span>
            <code :class="code" class="flex-none">{{ base }}</code>
          </span>
          <span class="whitespace-nowrap">{{ task.runs.length }} {{ task.runs.length === 1 ? 'run' : 'runs' }}</span>
          <span class="whitespace-nowrap">{{ task.source === 'planner' ? 'proposed' : 'created' }} {{ ago(task.created_at) }}</span>
          <TaskBadges :task="task" />
        </div>
        <TaskStatusLine :task="task" fit="full" cancel class="mt-1.5" />
      </div>
    </header>

    <!-- The tabs, and the task's actions at the end of the bar. -->
    <div class="flex items-end border-b border-border px-6">
      <TabBar class="min-w-0" label="Task" :tabs="TABS" :model-value="tab" @update:model-value="(key) => openTask(task.id, key)" />
      <div class="ml-auto self-center py-1 pl-3">
        <TaskActions :task="task" @act="(kind) => emit('act', kind)" @review="requesting = true" />
      </div>
    </div>

    <ReviewBar
      v-if="showReviewBar"
      :task-id="task.id"
      :draft="draft"
      :kind="requesting ? 'request_changes' : 'comment'"
      @close="requesting = false"
      @submitted="requesting = false"
    />

    <NeedsCallout v-if="needs" :task="task" :needs="needs" @retry="emit('act', 'retry')" />
    <div v-else-if="task.wait" class="callout flex items-center gap-3" :class="task.wait.kind === 'slots' ? 's-queued' : 's-blocked'">
      <span class="min-w-0 flex-1 wrap-anywhere">
        <strong>Not started yet.</strong> {{ describeWait(task.wait) }}.
        <template v-if="task.wait.kind === 'dependency' && task.wait.stuck">
          Retry #{{ task.wait.on[0] }} to release this task, or cancel it.
        </template>
      </span>
      <button v-if="task.wait.kind === 'daemon-paused'" class="primary" @click="resumeDaemon">▶ Resume</button>
      <button v-else-if="task.wait.kind === 'repo-paused'" class="primary" @click="resumeRepo">▶ Resume {{ task.repo }}</button>
      <template v-else-if="task.wait.kind === 'dependency'">
        <button v-for="on in task.wait.on" :key="on" @click="openTask(on)">Open #{{ on }}</button>
      </template>
    </div>
    <div v-else-if="s === 'proposed'" class="callout s-proposed">
      The planner suggested this task. Read the prompt, then approve it to queue it or reject it.
    </div>

    <div
      class="flex min-h-0 flex-1 gap-7 px-6 pt-4 max-md:flex-col"
      :class="
        tab === 'code' ? 'overflow-hidden pb-0' : tab === 'changes' ? 'overflow-y-auto pb-6 [container-type:size]' : 'overflow-y-auto pb-6'
      "
    >
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
