<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, type Repo, type Status, type Task, type TaskDetail as Detail, api } from './api';
import NewTaskForm from './components/NewTaskForm.vue';
import ReposPanel from './components/ReposPanel.vue';
import StatusBar from './components/StatusBar.vue';
import TaskDetail from './components/TaskDetail.vue';
import TaskList from './components/TaskList.vue';

const POLL_MS = 2000;

const status = ref<Status | null>(null);
const tasks = ref<Task[]>([]);
const repos = ref<Repo[]>([]);
const selectedId = ref<number | null>(null);
const detail = ref<Detail | null>(null);
const offline = ref(false);
const busy = ref(false);
const toast = ref('');
const modal = ref<'new' | 'repos' | null>(null);

let timer: number | undefined;

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ''), 3500);
}

async function refresh() {
  try {
    const [s, t] = await Promise.all([api.status(), api.tasks()]);
    status.value = s;
    tasks.value = t;
    if (offline.value || !repos.value.length) repos.value = await api.repos();
    offline.value = false;
    if (selectedId.value === null && t.length) selectedId.value = t[0].id;
    if (selectedId.value !== null) detail.value = await api.task(selectedId.value);
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

const togglePause = () => act(() => (status.value?.paused ? api.resume() : api.pause()));
const cancelSelected = () => act(() => api.cancel(selectedId.value!));
const retrySelected = () => act(() => api.retry(selectedId.value!));
const reloadRepos = async () => (repos.value = await api.repos());

function select(id: number) {
  selectedId.value = id;
  detail.value = null;
  refresh();
}

function onCreated(task: Detail) {
  modal.value = null;
  select(task.id);
  if (status.value?.paused) flash('Queued. The daemon is paused, so press Resume to start working.');
}

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
    />

    <div v-if="offline" class="offline">
      <h2>The AgentDeck daemon isn't running</h2>
      <p class="muted">Start it in a terminal and this window will connect on its own:</p>
      <pre>cd daemon && npm start</pre>
    </div>

    <main v-else class="body">
      <TaskList :tasks="tasks" :selected="selectedId" @select="select" />
      <TaskDetail
        v-if="detail"
        :task="detail"
        @cancel="cancelSelected"
        @retry="retrySelected"
      />
      <section v-else class="placeholder muted">
        <template v-if="tasks.length">Select a task.</template>
        <template v-else>
          No tasks yet.
          <button class="primary" @click="modal = repos.length ? 'new' : 'repos'">
            {{ repos.length ? 'Queue your first task' : 'Add a repo to get started' }}
          </button>
        </template>
      </section>
    </main>

    <NewTaskForm v-if="modal === 'new'" :repos="repos" @close="modal = null" @created="onCreated" @repos="modal = 'repos'" />
    <ReposPanel
      v-if="modal === 'repos'"
      :repos="repos"
      @close="modal = null"
      @changed="reloadRepos"
    />

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
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr;
  min-height: 0;
}
.placeholder {
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
