<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { api } from '../../../api/client';
import { repoQuery } from '../../../api/queries';
import type { Needs, TaskDetail } from '../../../api/types';
import { canInstallWith, depsAreDev, depsPackages, withHost } from '../../../lib/work/task-view';
import { useAction, useActions } from '../../../composables/shared/useActions';
import ConfirmDialog from '../../ui/ConfirmDialog.vue';

// What a blocked task's worker said it needs, with the one action that clears it.
const props = defineProps<{ task: TaskDetail; needs: Needs }>();
const emit = defineEmits<{ retry: [] }>();
const { flash } = useActions();
const { pending, run: act } = useAction();
const queryClient = useQueryClient();

// Only the toolchain (deps) and the network setting (host) need the repo.
const repoQ = useQuery(computed(() => ({ ...repoQuery(props.task.repo_id), enabled: props.needs.kind !== 'edit' })));
const repo = computed(() => repoQ.data.value ?? null);
watch(
  () => repoQ.error.value,
  (e) => e && flash(e.message),
);

const confirmHost = ref(false);

async function run(fn: () => Promise<unknown>) {
  if (pending.value) return;
  await act(fn);
  confirmHost.value = false;
}

const install = () => run(() => api.installNeeds(props.task.id));
const host = () => props.needs.items[0] ?? '';
// Allow the host on the repo, then retry the task.
const allow = () =>
  run(async () => {
    const r = repo.value ?? (await queryClient.fetchQuery(repoQuery(props.task.repo_id)));
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
      <button v-if="repo && canInstallWith(repo.toolchain)" class="primary" :disabled="pending" @click="install">Install and retry</button>
      <button v-else-if="repo" :disabled="pending" @click="emit('retry')">Install them on the branch, then Retry</button>
    </template>
    <button v-else-if="needs.kind === 'host'" class="primary" :disabled="pending" @click="confirmHost = true">
      Allow for {{ task.repo }} and retry
    </button>
    <button v-else :disabled="pending" @click="emit('retry')">↻ Retry</button>

    <ConfirmDialog
      v-if="confirmHost"
      title="Allow network access"
      :confirm-label="`Allow ${host()} for ${task.repo}`"
      :busy="pending"
      @cancel="confirmHost = false"
      @confirm="allow"
    >
      <p>
        Let sandboxed commands in <strong>{{ task.repo }}</strong> reach <code>{{ host() }}</code
        >? This changes the repo's network setting, so every future worker of {{ task.repo }} can reach it too. #{{ task.id }} is retried
        afterwards.
      </p>
    </ConfirmDialog>
  </div>
</template>
