<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type LinkKind, type TaskDetail, type TaskLink, type TaskSummary, api, tasksQuery } from '../../api';
import { openTask } from '../../router';
import { statusLabel } from '../../lib/taskView';
import { useActions } from '../../composables/useActions';
import StatusIcon from '../ui/StatusIcon.vue';

// What this task depends on (builds on, after) and what depends on it, each with where it stands.
// A refused link (a cycle, itself) shows the daemon's reason here.
const props = defineProps<{ task: TaskDetail }>();
const { run } = useActions();

// The task list the queue shares. Rows fall back to the bare id until it arrives (or if it fails), and a
// change to the links refreshes it through `run`.
const tasksQ = useQuery(tasksQuery());
const all = computed<TaskSummary[]>(() => tasksQ.data.value ?? []);
const byId = computed(() => new Map(all.value.map((t) => [t.id, t])));
// The task moved or its links did: the states shown for them may have too.
watch(
  () => [props.task.updated_at, JSON.stringify(props.task.links), JSON.stringify(props.task.dependents)],
  () => tasksQ.refetch(),
);

const links = computed(() => props.task.links ?? []);
const buildsOn = computed(() => links.value.filter((l) => l.kind === 'builds_on'));
const after = computed(() => links.value.filter((l) => l.kind === 'after'));
const dependents = computed(() => props.task.dependents ?? []);

const STATE_CLASS = { met: 'text-done', waiting: 'text-muted', stuck: 'text-blocked', holding: 'text-blocked' } as const;

/** One link's state in words: stuck says why in terms of the other task. */
function linkText(l: TaskLink): string {
  const other = byId.value.get(l.on);
  switch (l.state) {
    case 'met':
      return 'met';
    case 'waiting':
      return other ? `waiting: ${statusLabel(other.status).toLowerCase()}` : 'waiting';
    case 'stuck':
      return other ? `stuck: ${other.stop_reason ?? statusLabel(other.status).toLowerCase()}` : 'stuck: no longer exists';
    case 'holding':
      return 'holding the merge';
  }
}

/** A dependent's state is that of its link to this task. */
function dependentLink(id: number, kind: LinkKind): TaskLink | null {
  const link = byId.value.get(id)?.links?.find((l) => l.on === props.task.id && l.kind === kind);
  return link ?? null;
}

const adding = ref(false);
const query = ref('');
const kind = ref<LinkKind>('builds_on');
const error = ref<string | null>(null);

const linkedIds = computed(() => new Set(links.value.map((l) => l.on)));
const matches = computed(() => {
  const q = query.value.trim().replace(/^#/, '').toLowerCase();
  if (!q) return [];
  return all.value
    .filter((t) => t.id !== props.task.id && !linkedIds.value.has(t.id))
    .filter((t) => String(t.id) === q || t.title.toLowerCase().includes(q))
    .slice(0, 6);
});

function startAdding() {
  adding.value = true;
  query.value = '';
  error.value = null;
}

async function add(on: number) {
  error.value = null;
  try {
    await api.linkTask(props.task.id, { on, kind: kind.value });
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
  adding.value = false;
  await run(async () => {});
}

// Enter links the only match, or the exact #id typed.
function submit() {
  const q = query.value.trim().replace(/^#/, '');
  if (/^\d+$/.test(q)) return add(Number(q));
  if (matches.value.length === 1) return add(matches.value[0].id);
  error.value = 'Type a #id, or pick a task from the list.';
}

async function remove(on: number) {
  error.value = null;
  try {
    await api.unlinkTask(props.task.id, on);
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
  await run(async () => {});
}

const rowCls = 'flex min-w-0 items-center gap-2 px-3.5 py-1.5';
const open = 'btn-ghost flex min-w-0 flex-1 items-center gap-2 text-left hover:text-accent';
const heading = 'px-3.5 pt-2 pb-0.5 text-sm text-muted';
</script>

<template>
  <article class="card" aria-label="Dependencies">
    <header class="card-head gap-1.5 px-3.5 py-2">
      <b>Dependencies</b>
      <button v-if="!adding" class="ml-auto px-2 py-0 text-sm" @click="startAdding">Add link</button>
    </header>

    <form v-if="adding" class="flex flex-col gap-1.5 border-b border-border px-3.5 py-2" @submit.prevent="submit">
      <div class="flex items-center gap-1.5">
        <input v-model="query" class="min-w-0 flex-1 px-1.5 py-0.5" placeholder="#id or title" autofocus aria-label="Task to link" />
        <select v-model="kind" class="px-1.5 py-0.5" aria-label="Kind of link">
          <option value="builds_on">Builds on</option>
          <option value="after">After</option>
        </select>
        <button type="submit" class="px-2 py-0.5">Link</button>
        <button type="button" class="px-2 py-0.5" @click="adding = false">Cancel</button>
      </div>
      <ul v-if="matches.length" class="m-0 flex list-none flex-col p-0">
        <li v-for="t in matches" :key="t.id">
          <button type="button" class="btn-ghost flex w-full items-center gap-2 py-0.5 text-left hover:text-accent" @click="add(t.id)">
            <StatusIcon :task="t" /> <span class="text-muted">#{{ t.id }}</span> <span class="truncate">{{ t.title }}</span>
          </button>
        </li>
      </ul>
    </form>
    <p v-if="error" class="m-0 px-3.5 py-2 text-blocked" role="alert">{{ error }}</p>

    <p v-if="!links.length && !dependents.length && !adding" class="m-0 px-3.5 py-2 text-muted">
      Nothing depends on this task, and it depends on nothing.
    </p>

    <template
      v-for="group in [
        { label: 'Builds on', items: buildsOn },
        { label: 'After', items: after },
      ]"
      :key="group.label"
    >
      <template v-if="group.items.length">
        <div :class="heading">{{ group.label }}</div>
        <div v-for="l in group.items" :key="l.on" :class="rowCls">
          <button :class="open" @click="openTask(l.on)">
            <StatusIcon v-if="byId.get(l.on)" :task="byId.get(l.on)!" />
            <span class="text-muted">#{{ l.on }}</span>
            <span class="truncate">{{ byId.get(l.on)?.title ?? '' }}</span>
            <span class="ml-auto flex-none whitespace-nowrap" :class="STATE_CLASS[l.state]">{{ linkText(l) }}</span>
          </button>
          <button class="px-1.5 py-0 text-sm" :aria-label="`Remove the link to #${l.on}`" title="Remove link" @click="remove(l.on)">
            ✕
          </button>
        </div>
      </template>
    </template>

    <template v-if="dependents.length">
      <div :class="heading">Waiting on this</div>
      <div v-for="d in dependents" :key="d.id" :class="rowCls">
        <button :class="open" @click="openTask(d.id)">
          <StatusIcon v-if="byId.get(d.id)" :task="byId.get(d.id)!" />
          <span class="text-muted">#{{ d.id }}</span>
          <span class="truncate">{{ byId.get(d.id)?.title ?? '' }}</span>
          <span class="ml-auto flex-none whitespace-nowrap text-muted">
            {{ d.kind === 'builds_on' ? 'builds on this' : 'after this' }}
            <template v-if="dependentLink(d.id, d.kind)"
              >· <span :class="STATE_CLASS[dependentLink(d.id, d.kind)!.state]">{{ dependentLink(d.id, d.kind)!.state }}</span></template
            >
          </span>
        </button>
      </div>
    </template>
  </article>
</template>
