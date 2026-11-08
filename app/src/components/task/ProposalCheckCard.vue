<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { CHECKED_STATUSES, proposalCheckLine } from '../../../../daemon/src/domain/work/index.ts';
import { type TaskStatus, ago, api, proposalCheckQuery } from '../../api';
import { openTask } from '../../router';
import { statusLabel } from '../../lib/taskView';
import { useAction } from '../../composables/useActions';

// What to know before approving a proposed or queued task: how far the base moved since it was added, which named files
// changed, the named paths not on the base, and the open tasks touching the same files, each with an After link to add.
// Fetched only while such a task is shown: the check reads git, so it is never part of the task's detail.
const props = defineProps<{ task: { id: number; status: TaskStatus } }>();
const { pending, run } = useAction();

const checked = computed(() => CHECKED_STATUSES.includes(props.task.status));
const q = useQuery(computed(() => ({ ...proposalCheckQuery(props.task.id), enabled: checked.value })));
const check = computed(() => (checked.value ? (q.data.value ?? null) : null));
const line = computed(() => (check.value ? proposalCheckLine(check.value) : null));
const open = ref(false);

const addAfter = (on: number) =>
  run(() => api.linkTask(props.task.id, { on, kind: 'after' }), { done: `#${props.task.id} now lands after #${on}` });

const row = 'flex min-w-0 flex-wrap items-baseline gap-x-2 px-3.5 py-1';
const heading = 'px-3.5 pt-2 pb-0.5 text-sm text-muted';
</script>

<template>
  <article v-if="check && (line || check.notes.length)" class="card" aria-label="Proposal check">
    <button
      v-if="line"
      class="card-head w-full gap-1.5 rounded-none border-0 bg-transparent px-3.5 py-2 text-left"
      :aria-expanded="open"
      title="Show the files and the tasks"
      @click="open = !open"
    >
      <span class="text-muted">{{ open ? '▾' : '▸' }}</span>
      <span class="wrap-anywhere">{{ line }}</span>
      <span v-if="check.staleness" class="ml-auto text-sm text-muted">on {{ check.staleness.ref }}</span>
    </button>

    <template v-if="open">
      <template v-if="check.staleness?.changed.length">
        <div :class="heading">Named files changed since it was written</div>
        <div v-for="c in check.staleness.changed" :key="c.path" class="px-3.5 py-1">
          <div class="font-mono wrap-anywhere">{{ c.path }}</div>
          <div v-for="x in c.commits" :key="x.sha" class="flex min-w-0 items-baseline gap-2 pl-3 text-sm">
            <span class="font-mono text-muted">{{ x.sha.slice(0, 7) }}</span>
            <span class="truncate">{{ x.subject }}</span>
            <span class="ml-auto flex-none text-muted">{{ ago(x.at) }}</span>
          </div>
        </div>
      </template>

      <template v-if="check.overlaps.length">
        <div :class="heading">Touches the same files</div>
        <div v-for="o in check.overlaps" :key="o.id" :class="row">
          <button class="btn-ghost flex min-w-0 items-baseline gap-2 text-left hover:text-accent" @click="openTask(o.id)">
            <span class="font-mono text-muted">#{{ o.id }}</span>
            <span class="truncate">{{ o.title }}</span>
            <span class="text-sm text-muted">{{ statusLabel(o.status) }}</span>
          </button>
          <span v-if="o.linked" class="ml-auto text-sm text-muted">linked</span>
          <button
            v-else
            class="ml-auto px-2 py-0 text-sm"
            :disabled="pending"
            :title="`Land #${task.id} only after #${o.id}`"
            @click="addAfter(o.id)"
          >
            Add After link
          </button>
          <div class="w-full pl-3 font-mono text-sm text-muted wrap-anywhere">{{ o.paths.join(', ') }}</div>
        </div>
      </template>
    </template>

    <ul v-if="check.notes.length" class="m-0 list-none border-t border-border px-3.5 py-2 text-sm text-blocked first:border-t-0">
      <li v-for="n in check.notes" :key="n">{{ n }}</li>
    </ul>
  </article>
</template>
