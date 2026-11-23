<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { CHECKED_STATUSES } from '#daemon/domain/work/index.ts';
import { latestVerify } from '#daemon/domain/runs/index.ts';
import { reposQuery } from '#api/repos.ts';
import { runsApi } from '#api/runs.ts';
import { proposalCheckQuery } from '#api/work.ts';
import type { TaskDetail } from '#api/types.ts';
import { fixFindingsCommand } from '#lib/runs/terminal.ts';
import { hasFindingsToFix } from '#lib/runs/verify.ts';
import { useTerminal } from '#composables/runs/useTerminal.ts';
import { useAction, useActions } from '#composables/shared/useActions.ts';
import VerifyFindings from '#components/runs/VerifyFindings.vue';

const props = defineProps<{ task: Pick<TaskDetail, 'id' | 'title' | 'status' | 'runs' | 'repo_id' | 'issue'> }>();
const { pending, run } = useAction();
const { flash } = useActions();
const terminal = useTerminal();
const repos = useQuery(reposQuery());

const checked = computed(() => CHECKED_STATUSES.includes(props.task.status));
const q = useQuery(computed(() => ({ ...proposalCheckQuery(props.task.id), enabled: checked.value })));
const view = computed(() => latestVerify(props.task.runs, q.data.value?.staleness?.base ?? null));
const going = computed(() => view.value?.state === 'going');

const verify = () => run(() => runsApi.verify(props.task.id), { done: `Verify run started on #${props.task.id}` });

const fixable = computed(() => terminal.available.value && !!view.value && hasFindingsToFix(view.value));

function fix() {
  const cwd = repos.data.value?.find((r) => r.id === props.task.repo_id)?.path;
  if (!cwd) return flash(`Can't find the checkout for #${props.task.id}`);
  return run(() => terminal.open(`#${props.task.id} findings: ${props.task.title}`, cwd, fixFindingsCommand(props.task)));
}
</script>

<template>
  <article v-if="checked" class="card" aria-label="Verify run">
    <header class="card-head gap-1.5 px-3.5 py-2">
      <b>Verify run</b>
      <span v-if="!view" class="text-sm text-muted">Check the prompt’s claims about the code against the base</span>
      <button
        v-if="fixable"
        class="ml-auto px-2 py-0 text-sm"
        :disabled="pending"
        title="Open an interactive claude session to agree what the prompt should say"
        @click="fix"
      >
        Fix with Claude
      </button>
      <button
        class="px-2 py-0 text-sm"
        :class="!fixable && 'ml-auto'"
        :disabled="pending || going"
        title="A short read-only run on the review model; uses no attempt"
        @click="verify"
      >
        {{ view && !going ? 'Verify again' : 'Verify' }}
      </button>
    </header>
    <VerifyFindings v-if="view" class="px-3.5 py-2" :view="view" :task-id="task.id" />
  </article>
</template>
