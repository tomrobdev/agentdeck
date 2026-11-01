<script setup lang="ts">
// The daemon's health, opened from the status bar: the commit it loaded against HEAD, uptime, a reload that is
// pending or blocked, the failing checks of `agentdeck doctor` with their fix, and the end of the log.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api, daemonHealthQuery, daemonQuery, isOffline, taskList, uptime } from '../../api';
import { useActions } from '../../composables/useActions';
import Modal from '../ui/Modal.vue';

defineEmits<{ close: [] }>();
const { run, busy } = useActions();

const POLL_MS = 3000;
const stateQ = useQuery({ ...daemonQuery(), refetchInterval: POLL_MS });
const healthQ = useQuery(daemonHealthQuery());

const state = computed(() => stateQ.data.value ?? null);
const health = computed(() => healthQ.data.value ?? null);
const down = computed(() => isOffline(stateQ.error.value));

// Uptime ticks on its own; the daemon only says when it started.
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(tick));

const asked = ref(false);
const confirming = ref(false);
const requeued = ref<{ id: number; title: string }[]>([]);

// A restarted daemon is a new process: read its health again.
watch(
  () => state.value?.pid,
  (pid, was) => {
    if (was === undefined || pid === was) return;
    asked.value = false;
    void healthQ.refetch();
  },
);

const short = (c: string | null) => (c ? c.slice(0, 7) : 'unknown');
const commits = computed(() => {
  const loaded = state.value?.commit ?? null;
  const head = health.value?.head ?? null;
  if (!loaded || !head) return { text: `${short(loaded)} loaded · HEAD ${short(head)}`, stale: false };
  return loaded === head
    ? { text: `${short(loaded)}, same as HEAD`, stale: false }
    : { text: `${short(loaded)} loaded · HEAD is ${short(head)}`, stale: true };
});

const runningIds = computed(() => (health.value?.running ?? []).map((t) => t.id));
/** What a pending reload waits for, with the tasks named when they are known. */
const reloadLine = computed(() => {
  const r = state.value?.reload;
  if (!r?.pending) return null;
  if (!r.waiting) return 'A restart is coming now.';
  return runningIds.value.length
    ? `Restarts after ${taskList(runningIds.value)} finish${runningIds.value.length === 1 ? 'es' : ''}.`
    : `Restarts after ${r.waiting} finish.`;
});
const failing = computed(() => (health.value?.checks ?? []).filter((c) => !c.ok));

async function restartWhenIdle() {
  await run(async () => {
    await api.restartDaemon();
    asked.value = true;
  });
}

function askRestartNow() {
  // Read the running tasks afresh, so the question names what is running now.
  void healthQ.refetch();
  confirming.value = true;
}

async function restartNow() {
  confirming.value = false;
  await run(async () => {
    requeued.value = (await api.restartDaemonNow()).requeued;
  });
}

function refresh() {
  void stateQ.refetch();
  void healthQ.refetch();
}
</script>

<template>
  <Modal title="Daemon" @close="$emit('close')">
    <p v-if="down" class="s-blocked m-0 mb-3" role="status">
      The daemon isn't answering. If it was just restarted, this fills in when it is back.
    </p>
    <p v-else-if="stateQ.error.value" class="s-failed m-0 mb-3" role="alert">{{ stateQ.error.value.message }}</p>

    <dl v-if="state" class="m-0 mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt class="muted">Code</dt>
      <dd class="m-0" :class="{ 's-blocked': commits.stale }">{{ commits.text }}</dd>
      <dt class="muted">Uptime</dt>
      <dd class="m-0 tabular-nums">
        {{ uptime(state.started_at, now) }} <span class="muted">· pid {{ state.pid }}</span>
      </dd>
      <dt class="muted">Reload</dt>
      <dd class="m-0">
        <template v-if="reloadLine">{{ reloadLine }}</template>
        <template v-else-if="state.reload.blocked">
          <span class="s-blocked">Blocked: {{ state.reload.blocked }}</span>
        </template>
        <span v-else class="muted">{{ state.reload.enabled ? 'Nothing pending.' : 'Off (reload_on_change).' }}</span>
      </dd>
    </dl>

    <section v-if="failing.length" class="mb-3">
      <h4 class="m-0 mb-1">Failing checks</h4>
      <ul class="m-0 list-none p-0">
        <li v-for="c in failing" :key="c.name" class="mb-1.5">
          <b>{{ c.name }}</b
          >: {{ c.reason }}
          <div v-if="c.fix">
            <code>{{ c.fix }}</code>
          </div>
        </li>
      </ul>
    </section>
    <p v-else-if="health" class="muted m-0 mb-3">All {{ health.checks.length }} checks pass.</p>

    <section class="mb-3">
      <h4 class="m-0 mb-1">Log</h4>
      <pre v-if="health?.log.length" class="m-0 max-h-56 overflow-auto rounded-md border border-border bg-code-bg p-2 text-xs">{{
        health.log.join('\n')
      }}</pre>
      <p v-else class="muted m-0">{{ healthQ.isPending.value ? 'Loading…' : 'The log is empty.' }}</p>
    </section>

    <p v-if="requeued.length" class="m-0 mb-3" role="status">
      Restarting at once. {{ taskList(requeued.map((t) => t.id)) }} {{ requeued.length === 1 ? 'is' : 'are' }} requeued.
    </p>
    <p v-else-if="asked && !reloadLine" class="muted m-0 mb-3" role="status">Restarting…</p>

    <div
      v-if="confirming"
      class="s-blocked mb-3 rounded-md border border-[color-mix(in_srgb,var(--c)_40%,transparent)] p-2.5"
      role="alertdialog"
    >
      <template v-if="health?.running.length">
        Restart now? These tasks lose their run and are requeued:
        <ul class="my-1 pl-5">
          <li v-for="t in health.running" :key="t.id">#{{ t.id }} {{ t.title }}</li>
        </ul>
      </template>
      <template v-else>Restart now? No task is running.</template>
      <div class="mt-2 flex gap-2">
        <button class="primary" :disabled="busy" @click="restartNow">Restart now</button>
        <button @click="confirming = false">Cancel</button>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <button :disabled="busy || down" @click="refresh">Refresh</button>
      <div class="spacer" />
      <button :disabled="busy || down || asked" :title="'Pause new work, wait for running tasks, then restart'" @click="restartWhenIdle">
        {{ asked ? 'Waiting…' : 'Restart when idle' }}
      </button>
      <button :disabled="busy || down || confirming" @click="askRestartNow">Restart now…</button>
    </div>
  </Modal>
</template>
