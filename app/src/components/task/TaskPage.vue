<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { type Changes, type TaskDetail, ago, api } from '../../api';
import { type TaskTab, go, openTask } from '../../router';
import StatusIcon from '../queue/StatusIcon.vue';
import ChangesTab from './ChangesTab.vue';
import CodeTab from './CodeTab.vue';
import OverviewTab from './OverviewTab.vue';
import RunsTab from './RunsTab.vue';
import Sidebar from './Sidebar.vue';

// A task laid out like a pull request: header, tabs, and a properties sidebar.
const props = defineProps<{ task: TaskDetail; tab: TaskTab; query: Record<string, string> }>();
const emit = defineEmits<{ act: [kind: 'approve' | 'reject' | 'retry' | 'cancel']; changed: []; error: [msg: string] }>();

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
    changes.value = await api.changes(props.task.id);
    changesError.value = '';
  } catch (e) {
    changesError.value = (e as Error).message;
  }
}
watch(
  () => [props.task.id, props.task.updated_at, props.task.branch],
  (now, before) => {
    if (before && now[0] !== before[0]) changes.value = null;
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

const attempt = computed(() => (props.query.run ? Number(props.query.run) : null));
const openFile = (path: string, line: number | null = null) =>
  openTask(props.task.id, 'code', { ref: 'head', path, ...(line ? { L: String(line) } : {}) });

const s = computed(() => props.task.status);
const canCancel = computed(() => ['queued', 'running', 'blocked', 'failed'].includes(s.value));
const canRetry = computed(() => ['blocked', 'failed', 'cancelled', 'done'].includes(s.value));
const statusLabel = computed(() => (s.value === 'cancel_requested' ? 'stopping' : s.value));

// Editing the title in place, while the task is editable.
const editingTitle = ref(false);
const titleDraft = ref('');
const titleEditable = computed(() => ['proposed', 'queued', 'blocked', 'failed'].includes(s.value));
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

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  if (document.querySelector('[role="dialog"]')) return;
  go({ name: 'queue' });
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <section class="page">
    <header class="head">
      <button class="back" title="Back to the queue (Esc)" @click="go({ name: 'queue' })">←</button>
      <div class="titles">
        <h1 v-if="!editingTitle" :class="{ editable: titleEditable }" :title="titleEditable ? 'Click to edit' : ''" @click="editTitle">
          {{ task.title }} <span class="num">#{{ task.id }}</span>
        </h1>
        <input
          v-else
          v-model="titleDraft"
          class="title-input"
          autofocus
          @keydown.enter="saveTitle"
          @keydown.esc.prevent="editingTitle = false"
          @blur="saveTitle"
        />
        <div class="sub">
          <span class="pill" :class="`s-${task.status}`"><StatusIcon :task="task" :size="12" /> {{ statusLabel }}</span>
          <template v-if="task.branch">
            <code>{{ task.branch }}</code> <span class="muted">→</span> <code>{{ changes?.base_ref ?? 'base' }}</code>
          </template>
          <span class="muted">· {{ task.runs.length }} {{ task.runs.length === 1 ? 'run' : 'runs' }}</span>
          <span class="muted">· {{ task.source === 'planner' ? 'proposed by the planner' : 'created' }} {{ ago(task.created_at) }}</span>
        </div>
      </div>
      <div class="acts">
        <template v-if="s === 'proposed'">
          <button @click="emit('act', 'reject')">Reject</button>
          <button class="primary" @click="emit('act', 'approve')">✓ Approve</button>
        </template>
        <button v-if="canRetry" @click="emit('act', 'retry')">↻ Retry</button>
        <button v-if="canCancel" @click="emit('act', 'cancel')">{{ s === 'running' ? '■ Stop' : '✕ Cancel' }}</button>
      </div>
    </header>

    <nav class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        role="tab"
        :aria-selected="tab === t.key"
        :class="{ on: tab === t.key }"
        @click="openTask(task.id, t.key)"
      >
        {{ t.label }} <span v-if="t.count !== null" class="count">{{ t.count }}</span>
      </button>
    </nav>

    <div v-if="task.blocked_reason && (s === 'blocked' || s === 'failed')" class="callout" :class="`s-${s}`">{{ task.blocked_reason }}</div>
    <div v-else-if="task.waiting?.stuck" class="callout s-blocked">
      Can't start: {{ task.waiting.stuck }}. Retry #{{ task.waiting.on }} to release this task, or cancel it.
    </div>
    <div v-else-if="s === 'proposed'" class="callout s-proposed">
      The planner suggested this task. Read the prompt, then approve it to queue it or reject it.
    </div>

    <div class="content" :class="{ wide }">
      <div class="main">
        <OverviewTab
          v-if="tab === 'overview'"
          :task="task"
          :is-path="isPath"
          @run="(a) => openTask(task.id, 'runs', { run: String(a) })"
          @path="openFile"
        />
        <RunsTab
          v-else-if="tab === 'runs'"
          :task="task"
          :attempt="attempt"
          :is-path="isPath"
          @select="(a) => go({ name: 'task', id: task.id, tab: 'runs', query: { run: String(a) } }, { replace: true })"
          @file="openFile"
          @path="openFile"
        />
        <ChangesTab v-else-if="tab === 'changes'" :task="task" :changes="changes" :error="changesError" @open="openFile" />
        <CodeTab v-else :task="task" :query="query" :changed="knownPaths" />
      </div>
      <Sidebar v-if="!wide" :task="task" @changed="emit('changed')" @error="emit('error', $event)" />
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  background: var(--bg);
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 24px 8px;
}
.back {
  margin-top: 2px;
}
.titles {
  flex: 1;
  min-width: 0;
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}
h1.editable {
  cursor: text;
}
.num {
  color: var(--muted);
  font-weight: 400;
}
.title-input {
  font-size: 18px;
  font-weight: 600;
}
.sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 13px;
}
.sub code {
  background: color-mix(in srgb, var(--running) 10%, var(--panel));
  border-radius: 5px;
  padding: 1px 6px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--c) 16%, var(--panel));
  color: var(--c);
  font-weight: 500;
}
.acts {
  display: flex;
  gap: 6px;
  flex: none;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 8px 12px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tabs button.on {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.count {
  font-size: 11px;
  background: var(--panel-2);
  border-radius: 999px;
  padding: 0 6px;
  margin-left: 2px;
  font-weight: 500;
}
.callout {
  margin: 12px 24px 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
  background: color-mix(in srgb, var(--c) 9%, var(--panel));
}
.content {
  display: flex;
  gap: 28px;
  padding: 16px 24px 24px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.content.wide {
  overflow: hidden;
  padding-bottom: 0;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
@media (max-width: 900px) {
  .content {
    flex-direction: column;
  }
  .content :deep(.side) {
    width: 100%;
  }
}
</style>
