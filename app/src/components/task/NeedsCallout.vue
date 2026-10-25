<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { type Needs, type RepoDetail, type TaskDetail, api } from '../../api';
import { canInstallWith, depsAreDev, depsPackages, withHost } from '../../taskView';
import Modal from '../Modal.vue';

// What a blocked task's worker said it needs, with the one action that clears it.
const props = defineProps<{ task: TaskDetail; needs: Needs }>();
const emit = defineEmits<{ retry: []; changed: []; error: [msg: string] }>();

// Only the toolchain (deps) and the network setting (host) need the repo.
const repo = ref<RepoDetail | null>(null);
async function loadRepo() {
  if (props.needs.kind === 'edit') return;
  try {
    repo.value = await api.repo(props.task.repo_id);
  } catch (e) {
    emit('error', (e as Error).message);
  }
}
onMounted(loadRepo);
watch(() => [props.task.id, props.needs.kind], loadRepo);

const busy = ref(false);
const confirmHost = ref(false);

async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  try {
    await fn();
    confirmHost.value = false;
    emit('changed');
  } catch (e) {
    confirmHost.value = false;
    emit('error', (e as Error).message);
  } finally {
    busy.value = false;
  }
}

const install = () => run(() => api.installNeeds(props.task.id));
const host = () => props.needs.items[0] ?? '';
// Allow the host on the repo, then retry the task.
const allow = () =>
  run(async () => {
    const r = repo.value ?? (await api.repo(props.task.repo_id));
    await api.updateRepo(r.id, { network: withHost(r.network, host()) });
    await api.retry(props.task.id);
  });
</script>

<template>
  <div class="callout s-blocked flex items-start gap-3" data-needs :data-kind="needs.kind">
    <div class="min-w-0 flex-1 wrap-anywhere">
      <template v-if="needs.kind === 'deps'">
        <strong>Needs {{ depsPackages(needs).length === 1 ? 'a package' : 'packages' }}:</strong>
        <code v-for="p in depsPackages(needs)" :key="p" class="mx-0.5">{{ p }}</code>
        <span v-if="depsAreDev(needs)" class="text-muted">(dev dependencies)</span>
      </template>
      <template v-else-if="needs.kind === 'host'">
        <strong>Needs network access to</strong> <code>{{ host() }}</code>
      </template>
      <template v-else>
        <strong>Needs a change to</strong> <code>{{ needs.items.join(' ') }}</code
        >, which the worker may not edit. Make the edit yourself, then retry.
        <div v-if="task.stop_reason" class="mt-1 text-muted">{{ task.stop_reason }}</div>
      </template>
      <div v-if="needs.kind === 'deps' && repo && !canInstallWith(repo.toolchain)" class="mt-1 text-muted">
        {{ repo.name }} uses {{ repo.toolchain ?? 'no detected toolchain' }}, so install them on the branch yourself.
      </div>
    </div>
    <template v-if="needs.kind === 'deps'">
      <button v-if="repo && canInstallWith(repo.toolchain)" class="primary" :disabled="busy" @click="install">Install and retry</button>
      <button v-else-if="repo" :disabled="busy" @click="emit('retry')">Install them on the branch, then Retry</button>
    </template>
    <button v-else-if="needs.kind === 'host'" class="primary" :disabled="busy" @click="confirmHost = true">
      Allow for {{ task.repo }} and retry
    </button>
    <button v-else :disabled="busy" @click="emit('retry')">↻ Retry</button>

    <Modal v-if="confirmHost" title="Allow network access" @close="confirmHost = false">
      <p>
        Let sandboxed commands in <strong>{{ task.repo }}</strong> reach <code>{{ host() }}</code
        >? This changes the repo's network setting, so every future worker of {{ task.repo }} can reach it too. #{{ task.id }} is retried
        afterwards.
      </p>
      <div class="mt-3 flex justify-end gap-1.5">
        <button @click="confirmHost = false">Cancel</button>
        <button class="primary" :disabled="busy" autofocus @click="allow">Allow {{ host() }} for {{ task.repo }}</button>
      </div>
    </Modal>
  </div>
</template>
