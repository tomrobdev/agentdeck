<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { type MergeAllResult, type TaskSummary, api } from '../../api';
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
      </li>
    </ul>
    <p v-if="!running && !result" class="muted mt-3">
      Each merges with its task's method and deletes its branch; one that lands after another waits for it. One that can't merge stays open,
      and you'll see why. This can't be undone from here.
    </p>
    <p v-if="running" class="muted mt-3">Merging…</p>
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
      <button v-if="!result" class="primary" :disabled="running" @click="start">
        {{ running ? 'Merging…' : `Merge ${tasks.length}` }}
      </button>
    </div>
  </Modal>
</template>
