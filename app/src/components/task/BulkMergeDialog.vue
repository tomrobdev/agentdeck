<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { type RequestMergesResult, type TaskSummary, api } from '../../api';
import { useActions } from '../../composables/useActions';
import Modal from '../ui/Modal.vue';

// One confirm for several merges: the selection's, or every PR in review ("Merge all"). It records a merge request for each
// and closes at once; the daemon merges them one after another, each with its task's method and deleting its branch, and a PR
// that lands after another waits for it. A task it could not request stays listed with why. Enter confirms, Esc cancels.
const props = defineProps<{ tasks: TaskSummary[] }>();
const emit = defineEmits<{ close: []; done: [requested: number[]] }>();
const { refresh } = useActions();

const running = ref(false);
const result = ref<RequestMergesResult | null>(null);
const error = ref('');
const requested = computed(() => result.value?.requested ?? []);
const why = (id: number) => result.value?.failed.find((f) => f.id === id)?.reason;

async function start() {
  if (running.value || result.value) return;
  running.value = true;
  error.value = '';
  try {
    const res = await api.requestMerges(props.tasks.map((t) => t.id));
    await refresh();
    if (!res.failed.length) return emit('done', res.requested);
    result.value = res;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    running.value = false;
  }
}

const close = () => (running.value ? undefined : emit('done', requested.value));

// Enter confirms before it starts and closes after, except on a focused button, which handles its own Enter.
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
            <template v-if="requested.includes(t.id)">✓</template>
            <template v-else-if="why(t.id)">✕</template>
          </span>
          <span class="font-mono text-muted">#{{ t.id }}</span>
          <span class="min-w-0 flex-1 truncate">{{ t.title }}</span>
          <code class="max-w-[220px] truncate text-sm">{{ t.pr_url }}</code>
        </span>
        <span v-if="why(t.id)" class="pl-6 text-sm text-failed">{{ why(t.id) }}</span>
      </li>
    </ul>
    <p v-if="!result" class="muted mt-3">
      The daemon merges them one after another, each with its task's method, deleting its branch. One that is not ready waits for its checks
      or its sync; one that lands after another waits for it. This can't be undone from here.
    </p>
    <p v-else class="mt-3">Asked to merge {{ requested.length }} of {{ tasks.length }}.</p>
    <p v-if="error" class="form-error mt-3">{{ error }}</p>
    <div class="mt-4 flex justify-end gap-2">
      <button :disabled="running" @click="close">{{ result ? 'Close' : 'Cancel' }}</button>
      <button v-if="!result" class="primary" :disabled="running" @click="start">
        {{ running ? 'Working…' : `Merge ${tasks.length}` }}
      </button>
    </div>
  </Modal>
</template>
