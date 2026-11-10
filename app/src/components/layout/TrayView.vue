<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { isOffline, refreshAll } from '../../api/http';
import { liveStatusQuery, operationsApi } from '../../api/operations';
import { tasksQuery } from '../../api/work';
import { ATTENTION_LABELS, describeState } from '../../lib/operations/daemon-wording';
import { describeLive } from '../../lib/runs/run-wording';
import type { Status, TaskSummary } from '../../api/types';
import { createActions, trackPending } from '../../composables/shared/useActions';
import { useChangeStream } from '../../composables/shared/useChangeStream';
import { isNative, openFromTray, startDaemon } from '../../platform/native';
import { type Route, hashFor, taskUrl } from '../../router';
import AppProvider from '../ui/AppProvider.vue';
import Chip from '../ui/Chip.vue';

const statusQ = useQuery(liveStatusQuery());
const tasksQ = useQuery(tasksQuery());
useChangeStream();

const status = computed<Status | null>(() => statusQ.data.value ?? null);
const tasks = computed<TaskSummary[]>(() => tasksQ.data.value ?? []);
const offline = computed(() => isOffline(statusQ.error.value));
const state = computed(() => describeState(status.value, offline.value));

const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(tick));

const running = computed(() => {
  void now.value;
  return tasks.value.flatMap((t) => (t.live ? [{ id: t.id, title: t.title, live: describeLive(t.live) }] : []));
});
const attention = computed(() => status.value?.headline.attention ?? []);
const more = computed(() => Math.max(0, (status.value?.headline.need_you ?? 0) - attention.value.length));
const reviewDue = computed(() => status.value?.headline.review_due ?? []);

const error = ref('');
const queryClient = useQueryClient();
const actions = createActions(
  () => refreshAll(queryClient),
  (msg) => (error.value = msg),
);
const { pending: busy, run } = trackPending(actions);
function act(fn: () => Promise<unknown>) {
  error.value = '';
  void run(fn);
}
const toggle = () => act(() => (status.value?.paused ? operationsApi.resume() : operationsApi.pause()));
const start = () => act(startDaemon);

function open(url: string, browser: Route) {
  if (isNative) openFromTray(url).catch((e) => (error.value = String(e)));
  else window.open(hashFor(browser), '_blank');
}
const openTask = (id: number) => open(taskUrl(id), { name: 'task', id, tab: 'overview', query: {} });
const openQueue = () => open('agentdeck://queue', { name: 'queue' });
</script>

<template>
  <AppProvider>
    <div class="flex h-screen flex-col overflow-hidden bg-bg text-sm">
      <header class="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
        <Chip :status="state.cls.slice(2)" variant="tint" dot :title="state.title">{{ state.label }}</Chip>
        <span v-if="status && !offline" class="text-muted text-xs tabular-nums" :title="status.governor.reason ?? ''">
          {{ status.running }}/{{ status.governor.max_concurrent }} slots
        </span>
        <div class="spacer" />
        <button v-if="offline" :disabled="busy || !isNative" @click="start">{{ busy ? 'Starting…' : 'Start daemon' }}</button>
        <button v-else :disabled="busy || !status" :aria-pressed="!!status?.paused" @click="toggle">
          {{ status?.paused ? 'Resume' : 'Pause' }}
        </button>
      </header>

      <div v-if="!offline" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1.5 py-2">
        <section aria-labelledby="tray-running">
          <h2 id="tray-running" class="text-muted m-0 px-1.5 pb-1 text-xs font-medium">Running</h2>
          <p v-if="!running.length" class="text-muted m-0 px-1.5 text-xs">Nothing is running.</p>
          <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
            <li v-for="t in running" :key="t.id">
              <button class="row" @click="openTask(t.id)">
                <span class="truncate"
                  ><span class="text-muted">#{{ t.id }}</span> {{ t.title }}</span
                >
                <span class="text-muted truncate text-xs tabular-nums">{{ t.live }}</span>
              </button>
            </li>
          </ul>
        </section>

        <section aria-labelledby="tray-attention">
          <h2 id="tray-attention" class="text-muted m-0 px-1.5 pb-1 text-xs font-medium">Needs you</h2>
          <p v-if="!attention.length" class="text-muted m-0 px-1.5 text-xs">Nothing needs you.</p>
          <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
            <li v-for="t in attention" :key="t.id">
              <button class="row" @click="openTask(t.id)">
                <span class="truncate"
                  ><span class="text-muted">#{{ t.id }}</span> {{ t.title }}</span
                >
                <span class="text-muted text-xs">{{ ATTENTION_LABELS[t.why] }}</span>
              </button>
            </li>
          </ul>
          <p v-if="more" class="text-muted m-0 px-1.5 pt-1 text-xs">and {{ more }} more</p>
          <p v-for="r in reviewDue" :key="r.repo" class="m-0 px-1.5 pt-1 text-xs text-blocked">{{ r.repo }}: {{ r.line }}</p>
        </section>
      </div>
      <p v-else class="text-muted m-auto px-6 text-center">The AgentDeck daemon isn't running.</p>

      <footer class="flex items-center gap-2 border-t border-border bg-panel px-3 py-2">
        <p v-if="error" class="m-0 truncate text-xs text-blocked" role="alert" :title="error">{{ error }}</p>
        <div class="spacer" />
        <button @click="openQueue">Open AgentDeck</button>
      </footer>
    </div>
  </AppProvider>
</template>

<style scoped>
.row {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 4px 6px;
  text-align: left;
}
.row:hover:not(:disabled) {
  background: var(--panel-2);
}
</style>
