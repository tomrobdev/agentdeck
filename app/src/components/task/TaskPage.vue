<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { type Changes, type MergeResult, type TaskDetail, ago, api, describeHold } from '../../api';
import { useHotkeys } from '../../hotkeys';
import { type TaskTab, go, openTask } from '../../router';
import { canApprove, canCancel, canEdit, canMerge, canRetry, canReview, readNeeds, statusLabel } from '../../taskView';
import Modal from '../Modal.vue';
import SnippetPopover from '../files/SnippetPopover.vue';
import StatusIcon from '../queue/StatusIcon.vue';
import ChangesTab from './ChangesTab.vue';
import CodeTab from './CodeTab.vue';
import MergeDialog from './MergeDialog.vue';
import NeedsCallout from './NeedsCallout.vue';
import OverviewTab from './OverviewTab.vue';
import RunsTab from './RunsTab.vue';
import Sidebar from './Sidebar.vue';

// A task laid out like a pull request: header, tabs, and a properties sidebar.
const props = defineProps<{ task: TaskDetail; tab: TaskTab; query: Record<string, string> }>();
const emit = defineEmits<{ act: [kind: 'approve' | 'reject' | 'retry' | 'cancel']; changed: []; error: [msg: string] }>();

const pageEl = ref<HTMLElement | null>(null);

const resumeRepo = () => api.resumeRepo(props.task.repo_id);

/** Clear what holds this task back (resume the daemon or the repo), then refresh. */
async function clearHold(fn: () => Promise<unknown>) {
  try {
    await fn();
    emit('changed');
  } catch (e) {
    emit('error', (e as Error).message);
  }
}
const changes = ref<Changes | null>(null);
const changesError = ref('');

// Changes follow the branch: fetch on open and whenever the task moves.
async function loadChanges() {
  if (!props.task.branch) {
    changes.value = null;
    changesError.value = 'No branch yet: changes appear once the first run starts.';
    return;
  }
  try {
    const next = await api.changes(props.task.id);
    changesError.value = '';
    // Same commits, same changes: keep the object so nothing downstream rebuilds.
    if (next.head === changes.value?.head && next.base === changes.value?.base) return;
    changes.value = next;
  } catch (e) {
    changesError.value = (e as Error).message;
  }
}
// Separate sources, so a poll that returns the same values doesn't refetch.
watch(
  [() => props.task.id, () => props.task.updated_at, () => props.task.branch],
  ([id], before) => {
    if (before && id !== before[0]) changes.value = null;
    loadChanges();
  },
  { immediate: true },
);

// A running task commits without changing status, so check its branch every 10 s.
const timer = window.setInterval(() => props.task.status === 'running' && loadChanges(), 10_000);
onBeforeUnmount(() => clearInterval(timer));

const knownPaths = computed(() => new Set(changes.value?.files.map((f) => f.path) ?? []));
const isPath = (p: string) => knownPaths.value.has(p);

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

// Editing the title in place, while the task is editable.
const editingTitle = ref(false);
const titleDraft = ref('');
const titleEditable = computed(() => canEdit(props.task));
function editTitle() {
  if (!titleEditable.value) return;
  titleDraft.value = props.task.title;
  editingTitle.value = true;
}
async function saveTitle() {
  if (!editingTitle.value) return;
  editingTitle.value = false;
  const t = titleDraft.value.trim();
  if (!t || t === props.task.title) return;
  try {
    await api.editTask(props.task.id, { title: t });
    emit('changed');
  } catch (e) {
    emit('error', (e as Error).message);
  }
}

// Review actions on a done task's open PR. Both ask first: one sends the task back, the other closes the PR on GitHub.
const reviewDialog = ref<'changes' | 'close' | null>(null);
const note = ref('');
const reviewBusy = ref(false);
function openReview(kind: 'changes' | 'close') {
  note.value = '';
  reviewDialog.value = kind;
}
async function submitReview() {
  const kind = reviewDialog.value;
  if (!kind || reviewBusy.value) return;
  if (kind === 'changes' && !note.value.trim()) return;
  reviewBusy.value = true;
  try {
    await (kind === 'changes' ? api.retry(props.task.id, note.value.trim()) : api.closePr(props.task.id));
    reviewDialog.value = null;
    emit('changed');
  } catch (e) {
    reviewDialog.value = null;
    emit('error', (e as Error).message);
  } finally {
    reviewBusy.value = false;
  }
}

const merging = ref(false);
function onMerged(result: MergeResult) {
  merging.value = false;
  emit('changed');
  if (result.cleanup_error) emit('error', `Merged, but cleanup failed: ${result.cleanup_error}`);
}

useHotkeys({ Escape: () => !reviewDialog.value && !merging.value && go({ name: 'queue' }) });

// Branch names under the title.
const code = 'rounded-[5px] bg-[color-mix(in_srgb,var(--running)_10%,var(--panel))] px-1.5 py-px';
</script>

<template>
  <section ref="pageEl" class="flex min-h-0 flex-1 flex-col bg-bg">
    <SnippetPopover v-if="pageEl" :task-id="task.id" :root="pageEl" />
    <header class="flex items-start gap-3 px-6 pt-4 pb-2">
      <button class="mt-0.5" title="Back to the queue (Esc)" @click="go({ name: 'queue' })">←</button>
      <div class="min-w-0 flex-1">
        <h1
          v-if="!editingTitle"
          class="m-0 text-xl leading-[1.3] font-semibold"
          :class="titleEditable && 'cursor-text'"
          :title="titleEditable ? 'Click to edit' : ''"
          @click="editTitle"
        >
          {{ task.title }} <span class="font-normal text-muted">#{{ task.id }}</span>
        </h1>
        <input
          v-else
          v-model="titleDraft"
          class="text-xl font-semibold"
          autofocus
          @keydown.enter="saveTitle"
          @keydown.esc.prevent="editingTitle = false"
          @blur="saveTitle"
        />
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
      <div class="flex flex-none gap-1.5">
        <template v-if="canApprove(task)">
          <button @click="emit('act', 'reject')">Reject</button>
          <button class="primary" @click="emit('act', 'approve')">✓ Approve</button>
        </template>
        <template v-if="canReview(task)">
          <button @click="openReview('close')">Close PR</button>
          <button @click="openReview('changes')">↻ Request changes</button>
        </template>
        <button v-else-if="canRetry(task)" @click="emit('act', 'retry')">↻ Retry</button>
        <button v-if="canMerge(task)" class="primary" @click="merging = true">Merge PR</button>
        <button v-if="canCancel(task)" @click="emit('act', 'cancel')">{{ s === 'running' ? '■ Stop' : '✕ Cancel' }}</button>
      </div>
    </header>

    <MergeDialog v-if="merging" :task-id="task.id" @close="merging = false" @merged="onMerged" @changed="emit('changed')" />

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

    <NeedsCallout
      v-if="needs"
      :task="task"
      :needs="needs"
      @retry="emit('act', 'retry')"
      @changed="emit('changed')"
      @error="emit('error', $event)"
    />
    <div v-else-if="task.blocked_reason && (s === 'blocked' || s === 'failed')" class="callout" :class="`s-${s}`">
      {{ task.blocked_reason }}
    </div>
    <div v-else-if="task.hold" class="callout flex items-center gap-3" :class="task.hold.kind === 'slots' ? 's-queued' : 's-blocked'">
      <span class="min-w-0 flex-1 wrap-anywhere">
        <strong>Not started yet.</strong> {{ describeHold(task.hold) }}.
        <template v-if="task.hold.kind === 'dependency' && task.hold.stuck">
          Retry #{{ task.hold.on }} to release this task, or cancel it.
        </template>
      </span>
      <button v-if="task.hold.kind === 'daemon-paused'" class="primary" @click="clearHold(api.resume)">▶ Resume</button>
      <button v-else-if="task.hold.kind === 'repo-paused'" class="primary" @click="clearHold(resumeRepo)">▶ Resume {{ task.repo }}</button>
      <button v-else-if="task.hold.kind === 'dependency'" @click="openTask(task.hold.on)">Open #{{ task.hold.on }}</button>
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
      <Sidebar v-if="!wide" :task="task" @changed="emit('changed')" @error="emit('error', $event)" />
    </div>

    <Modal v-if="reviewDialog === 'changes'" title="Request changes" @close="reviewDialog = null">
      <p class="text-muted">
        Sends #{{ task.id }} back for another attempt on the same branch. The note goes first in the next run's prompt and shows on the
        timeline.
      </p>
      <textarea
        v-model="note"
        class="w-full resize-y"
        rows="5"
        placeholder="What should change?"
        autofocus
        @keydown.enter.meta.prevent="submitReview"
        @keydown.enter.ctrl.prevent="submitReview"
      />
      <div class="mt-3 flex justify-end gap-1.5">
        <button @click="reviewDialog = null">Cancel</button>
        <button class="primary" :disabled="!note.trim() || reviewBusy" @click="submitReview">Request changes</button>
      </div>
    </Modal>
    <Modal v-if="reviewDialog === 'close'" title="Close pull request" @close="reviewDialog = null">
      <p>
        Close the pull request for #{{ task.id }} on GitHub without merging it? Tasks waiting on this one will stay stuck until it is
        retried or they are cancelled.
      </p>
      <p>
        <a :href="task.pr_url ?? ''" target="_blank" rel="noreferrer">{{ task.pr_url }}</a>
      </p>
      <div class="mt-3 flex justify-end gap-1.5">
        <button @click="reviewDialog = null">Cancel</button>
        <button class="primary" :disabled="reviewBusy" autofocus @click="submitReview">Close PR</button>
      </div>
    </Modal>
  </section>
</template>
