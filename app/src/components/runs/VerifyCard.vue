<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { CHECKED_STATUSES } from '#daemon/domain/work/index.ts';
import { latestVerify } from '#daemon/domain/runs/index.ts';
import { runsApi } from '#api/runs.ts';
import { proposalCheckQuery } from '#api/work.ts';
import type { TaskDetail } from '#api/types.ts';
import { useAction } from '#composables/shared/useActions.ts';
import VerifyFindings from '#components/runs/VerifyFindings.vue';

const props = defineProps<{ task: Pick<TaskDetail, 'id' | 'status' | 'runs'> }>();
const emit = defineEmits<{ path: [path: string, line: number | null] }>();
const { pending, run } = useAction();

const checked = computed(() => CHECKED_STATUSES.includes(props.task.status));
const q = useQuery(computed(() => ({ ...proposalCheckQuery(props.task.id), enabled: checked.value })));
const view = computed(() => latestVerify(props.task.runs, q.data.value?.staleness?.base ?? null));
const going = computed(() => view.value?.state === 'going');

const verify = () => run(() => runsApi.verify(props.task.id), { done: `Verify run started on #${props.task.id}` });
</script>

<template>
  <article v-if="checked" class="card" aria-label="Verify run">
    <header class="card-head gap-1.5 px-3.5 py-2">
      <b>Verify run</b>
      <span v-if="!view" class="text-sm text-muted">Check the prompt’s claims about the code against the base</span>
      <button
        class="ml-auto px-2 py-0 text-sm"
        :disabled="pending || going"
        title="A short read-only run on the review model; uses no attempt"
        @click="verify"
      >
        {{ view && !going ? 'Verify again' : 'Verify' }}
      </button>
    </header>
    <VerifyFindings v-if="view" class="px-3.5 py-2" :view="view" @path="(p, l) => emit('path', p, l)" />
  </article>
</template>
