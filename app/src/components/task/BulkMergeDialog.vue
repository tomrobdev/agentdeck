<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { type MergeAllResult, type TaskSummary, api, syncLine } from '../../api';
import { useActions } from '../../composables/useActions';
import Modal from '../ui/Modal.vue';

// One confirm for several merges: the selection's, or every PR in review ("Merge all"). The daemon merges them in one go
// (mergeAll): each with its task's method, deleting the branch, and a PR that lands after another waits for it. One that
// can't merge, a conflict say, doesn't stop the rest; it stays open and the dialog says why. Enter merges, Esc cancels.
const props = defineProps<{ tasks: TaskSummary[] }>();
const emit = defineEmits<{ close: []; done: [merged: number[]] }>();
const { refresh } = useActions();

const running = ref(false);
const result = ref<MergeAllResult | null>(null);
const error = ref('');
const merged = computed(() => result.value?.merged.map((m) => m.id) ?? []);
const why = (id: number) => result.value?.skipped.find((s) => s.id === id)?.reason;
const cleanup = computed(() => result.value?.merged.filter((m) => m.cleanup_error).map((m) => `#${m.id}: ${m.cleanup_error}`) ?? []);
const started = computed(() => [...new Set(result.value?.merged.flatMap((m) => m.unblocked) ?? [])]);

async function start() {
  if (running.value || result.value) return;
  running.value = true;
  error.value = '';
  try {
    result.value = await api.mergeAll(props.tasks.map((t) => t.id));
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
  }
}

// A PR left open because it conflicts can be synced from here, one at a time, and the ones that synced merged in one go.
// Closing the dialog doesn't stop the sync under way: the daemon finishes it and the queue shows it from the task's summary.
interface SyncState {
  state: 'syncing' | 'synced' | 'blocked';
  line: string;
}
const syncs = ref<Record<number, SyncState>>({});
const conflicting = computed(() => result.value?.skipped.filter((s) => s.conflicting).map((s) => s.id) ?? []);
const unsynced = computed(() => conflicting.value.filter((id) => !syncs.value[id] || syncs.value[id].state === 'blocked'));
const synced = computed(() => conflicting.value.filter((id) => syncs.value[id]?.state === 'synced'));
const syncingNow = computed(() => Object.values(syncs.value).some((s) => s.state === 'syncing'));
let closed = false;

async function syncOne(id: number) {
  syncs.value = { ...syncs.value, [id]: { state: 'syncing', line: 'Syncing…' } };
  try {
    const r = await api.sync(id);
    const line = `${syncLine(r)}${r.push_error ? ` Could not push: ${r.push_error}` : ''}`;
    const ok = (r.outcome === 'clean' || r.outcome === 'resolved' || r.outcome === 'up_to_date') && !r.push_error;
    syncs.value = { ...syncs.value, [id]: { state: ok ? 'synced' : 'blocked', line } };
  } catch (e) {
    syncs.value = { ...syncs.value, [id]: { state: 'blocked', line: (e as Error).message } };
  }
  await refresh();
}
async function syncAll(ids: number[]) {
  if (syncingNow.value) return;
  for (const id of ids) {
    if (closed) return;
    await syncOne(id);
  }
}

// The synced ones merge through the same call as the first round, and replace their entries in the result.
async function mergeSynced() {
  const ids = [...synced.value];
  if (running.value || !ids.length || !result.value) return;
  running.value = true;
  error.value = '';
  try {
    const next = await api.mergeAll(ids);
    const before = result.value;
    result.value = {
      merged: [...before.merged, ...next.merged],
      skipped: [...before.skipped.filter((s) => !ids.includes(s.id)), ...next.skipped],
    };
    // One that conflicts again (the base moved) can be synced again.
    for (const s of next.skipped) delete syncs.value[s.id];
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
  }
}
onBeforeUnmount(() => (closed = true));

const close = () => (running.value ? undefined : emit('done', merged.value));

// Enter merges before it starts and closes after, except on a focused button, which handles its own Enter.
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
  if (e.target instanceof HTMLElement && e.target.closest('button, a')) return;
  e.preventDefault();
  if (result.value) close();
  else start();
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Modal :title="`Merge ${tasks.length} ${tasks.length === 1 ? 'pull request' : 'pull requests'}`" @close="close">
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      <li v-for="t in tasks" :key="t.id" class="flex flex-col">
        <span class="flex items-baseline gap-2">
          <span class="w-4 flex-none">
            <template v-if="merged.includes(t.id)">✓</template>
            <template v-else-if="why(t.id)">✕</template>
            <template v-else-if="running">…</template>
          </span>
          <span class="font-mono text-muted">#{{ t.id }}</span>
          <span class="min-w-0 flex-1 truncate">{{ t.title }}</span>
          <code class="max-w-[220px] truncate text-sm">{{ t.pr_url }}</code>
        </span>
        <span v-if="why(t.id)" class="pl-6 text-sm text-failed">{{ why(t.id) }}</span>
        <span v-if="syncs[t.id]" class="pl-6 text-sm" :class="syncs[t.id].state === 'blocked' ? 'text-failed' : 'text-muted'">
          {{ syncs[t.id].line }}
        </span>
        <span v-if="conflicting.includes(t.id) && unsynced.includes(t.id)" class="pl-6">
          <button class="btn-mini" :disabled="running || syncingNow" @click="syncAll([t.id])">Sync</button>
        </span>
      </li>
    </ul>
    <p v-if="!running && !result" class="muted mt-3">
      Each merges with its task's method and deletes its branch; one that lands after another waits for it. One that can't merge stays open,
      and you'll see why. This can't be undone from here.
    </p>
    <p v-if="running" class="muted mt-3">Merging…</p>
    <p v-if="unsynced.length" class="muted mt-3">
      A PR that conflicts with the base branch can be synced from here: claude settles the conflicts, which can take a few minutes. Closing
      this doesn't stop it.
    </p>
    <p v-if="result" class="mt-3">
      Merged {{ merged.length }} of {{ tasks.length }}.<template v-if="started.length">
        {{ started.map((id) => `#${id}`).join(', ') }} can start.</template
      >
    </p>
    <p v-if="error" class="form-error mt-3">{{ error }}</p>
    <ul v-if="cleanup.length" class="form-error m-0 mt-3 list-none p-0">
      <li v-for="c in cleanup" :key="c">Cleanup failed {{ c }}</li>
    </ul>
    <div class="mt-4 flex justify-end gap-2">
      <button :disabled="running" @click="close">{{ result ? 'Close' : 'Cancel' }}</button>
      <button v-if="unsynced.length > 1" :disabled="running || syncingNow" @click="syncAll(unsynced)">
        Sync the {{ unsynced.length }} conflicting
      </button>
      <button v-if="synced.length" class="primary" :disabled="running || syncingNow" @click="mergeSynced">
        {{ running ? 'Merging…' : `Merge the ${synced.length} synced` }}
      </button>
      <button v-if="!result" class="primary" :disabled="running" @click="start">
        {{ running ? 'Merging…' : `Merge ${tasks.length}` }}
      </button>
    </div>
  </Modal>
</template>
