<script setup lang="ts">
import { type Ref, computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { ApiError, type Repo, type Status, type TaskSummary, type TaskDetail as Detail, api, describeState } from './api';
import { setTrayStatus } from './native';
import NewTaskForm from './components/NewTaskForm.vue';
import ReposPanel from './components/ReposPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StatusBar from './components/StatusBar.vue';
import QueueView from './components/queue/QueueView.vue';
import TaskPage from './components/task/TaskPage.vue';
import { openTask, route } from './router';
import type { BoardMove } from './taskView';

const POLL_MS = 2000;

const status = ref<Status | null>(null);
const tasks = ref<TaskSummary[]>([]);
const repos = ref<Repo[]>([]);
const selectedId = ref<number | null>(null);
const detail = ref<Detail | null>(null);
const offline = ref(false);
const busy = ref(false);
const toast = ref('');
const modal = ref<'new' | 'repos' | 'settings' | null>(null);

let timer: number | undefined;

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ''), 3500);
}

// Each poll returns fresh objects. Keeping the old one when nothing changed stops every watcher and
// computed below from re-running (and re-fetching) every 2 s.
const lastJson = new Map<string, string>();
function keep<T>(target: Ref<T>, key: string, next: T) {
  const json = JSON.stringify(next);
  if (lastJson.get(key) === json) return;
  lastJson.set(key, json);
  target.value = next;
}

async function refresh() {
  try {
    // A task page only needs that task; the queue needs the list.
    const id = pageId.value;
    const [s, list, task] = await Promise.all([api.status(), id === null ? api.tasks() : null, id === null ? null : api.task(id)]);
    keep(status, 'status', s);
    if (list) keep(tasks, 'tasks', list);
    if (task && pageId.value === task.id) keep(detail, 'detail', task);
    if (offline.value || !repos.value.length) repos.value = await api.repos();
    offline.value = false;
  } catch (e) {
    if (e instanceof ApiError && e.message === 'offline') offline.value = true;
  }
}

async function act(fn: () => Promise<unknown>) {
  busy.value = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    flash((e as Error).message);
  } finally {
    busy.value = false;
  }
}

/** The task whose page is open, from the route. */
const pageId = computed(() => (route.current.name === 'task' ? route.current.id : null));
watch(pageId, (id) => {
  if (id !== null) selectedId.value = id;
  if (detail.value?.id !== id) {
    detail.value = null;
    lastJson.delete('detail');
  }
  refresh();
});

const togglePause = () => act(() => (status.value?.paused ? api.resume() : api.pause()));
const ACTIONS: Record<BoardMove, (id: number) => Promise<unknown>> = {
  approve: api.approve,
  reject: api.reject,
  retry: api.retry,
  cancel: api.cancel,
};
const actOn = (kind: BoardMove, id: number) => act(() => ACTIONS[kind](id));
const reloadRepos = async () => (repos.value = await api.repos());

function onCreated(task: Detail) {
  modal.value = null;
  openTask(task.id);
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}

watchEffect(() => {
  const s = status.value;
  const label = describeState(s, offline.value).label;
  const waiting = (s?.counts.proposed ?? 0) + (s?.counts.blocked ?? 0);
  setTrayStatus(waiting ? `${label} · ${waiting} need you` : label);
});

onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, POLL_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="shell">
    <StatusBar
      :status="status"
      :offline="offline"
      :busy="busy"
      @toggle="togglePause"
      @new-task="modal = 'new'"
      @repos="modal = 'repos'"
      @settings="modal = 'settings'"
    />

    <div v-if="offline" class="offline">
      <h2>The AgentDeck daemon isn't running</h2>
      <p class="muted">Start it in a terminal and this window will connect on its own:</p>
      <pre>cd daemon && npm start</pre>
    </div>

    <main v-else-if="pageId !== null" class="body">
      <TaskPage
        v-if="detail && route.current.name === 'task'"
        :task="detail"
        :tab="route.current.tab"
        :query="route.current.query"
        @act="(kind) => actOn(kind, detail!.id)"
        @changed="refresh"
        @error="flash"
      />
      <section v-else class="placeholder muted">Loading task #{{ pageId }}…</section>
    </main>
    <main v-else class="body">
      <QueueView v-if="tasks.length" v-model:selected="selectedId" :tasks="tasks" @open="openTask" @act="actOn" @new-task="modal = 'new'" />
      <section v-else class="placeholder muted">
        No tasks yet.
        <button class="primary" @click="modal = repos.length ? 'new' : 'repos'">
          {{ repos.length ? 'Queue your first task' : 'Add a repo to get started' }}
        </button>
      </section>
    </main>

    <NewTaskForm v-if="modal === 'new'" :repos="repos" @close="modal = null" @created="onCreated" @repos="modal = 'repos'" />
    <ReposPanel v-if="modal === 'repos'" :repos="repos" @close="modal = null" @changed="reloadRepos" />

    <SettingsPanel v-if="modal === 'settings'" :notifications="status?.notifications ?? []" @close="modal = null" @saved="refresh" />

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
}
.offline {
  margin: auto;
  text-align: center;
  max-width: 420px;
}
.offline h2 {
  font-size: 16px;
}
.offline pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px;
}
.toast {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--bg);
  padding: 8px 14px;
  border-radius: 8px;
  max-width: calc(100vw - 32px);
}
</style>
