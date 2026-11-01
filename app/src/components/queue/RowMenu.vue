<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { type LinkKind, type TaskSummary, api } from '../../api';
import { useActions } from '../../composables/useActions';
import { openExternal, useCopy } from '../../platform/native';
import {
  type PersonEvent,
  MODELS,
  PRIORITY_LEVELS,
  branchName,
  canEdit,
  canReview,
  levelPriority,
  personEvents,
  priorityLevel,
} from '../../lib/taskView';

// The menu a row opens on right-click, the context-menu key or ⇧F10: the task's usual actions and properties.
const props = defineProps<{ task: TaskSummary; x: number; y: number }>();
const emit = defineEmits<{ close: []; open: [id: number]; act: [kind: PersonEvent, id: number]; merge: [id: number] }>();
const { run, flash } = useActions();
const { copy } = useCopy();

const root = ref<HTMLElement | null>(null);
const section = ref<'priority' | 'model' | 'link' | null>(null);
const linkTo = ref('');
const editable = computed(() => canEdit(props.task));

const LABELS: Record<PersonEvent, string> = {
  approve: 'Approve',
  reject: 'Reject',
  retry: 'Retry',
  cancel: 'Cancel task',
  mark_done: 'Mark done',
};
// A done task with an open PR is sent back with a note from its page, so Retry is not offered here.
const events = computed(() => personEvents(props.task).filter((e) => !(e === 'retry' && canReview(props.task))));

const pos = ref({ left: props.x, top: props.y });
function place() {
  const el = root.value;
  if (!el) return;
  pos.value = {
    left: Math.max(4, Math.min(props.x, window.innerWidth - el.offsetWidth - 4)),
    top: Math.max(4, Math.min(props.y, window.innerHeight - el.offsetHeight - 4)),
  };
}
const items = () => [...(root.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])];

function toggle(s: 'priority' | 'model' | 'link') {
  section.value = section.value === s ? null : s;
  nextTick(place);
}
function done(fn: () => unknown) {
  emit('close');
  return fn();
}
const setPriority = (value: number) =>
  done(() => value !== props.task.priority && run(() => api.editTask(props.task.id, { priority: value })));
const setModel = (model: string) => done(() => model !== props.task.model && run(() => api.editTask(props.task.id, { model })));
const copyText = (text: string, what: string) => done(async () => (await copy(text, what), flash(`Copied ${what}`)));

async function link(kind: LinkKind) {
  const on = Number(linkTo.value.trim().replace(/^#/, ''));
  if (!Number.isInteger(on) || on < 1) return flash('Enter the task to link as #id');
  emit('close');
  await run(() => api.linkTask(props.task.id, { on, kind }), {
    done: `#${props.task.id} ${kind === 'after' ? 'after' : 'builds on'} #${on}`,
  });
}

function onDoc(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) emit('close');
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
    return;
  }
  const move = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!move) return;
  e.preventDefault();
  e.stopPropagation();
  const list = items();
  const i = list.indexOf(document.activeElement as HTMLElement);
  list[(i + move + list.length) % list.length]?.focus();
}
onMounted(async () => {
  document.addEventListener('mousedown', onDoc);
  document.addEventListener('keydown', onKey, true);
  await nextTick();
  place();
  items()[0]?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDoc);
  document.removeEventListener('keydown', onKey, true);
});

const item =
  'flex w-full items-center justify-between gap-3 rounded-sm border-0 bg-transparent px-2 py-1 text-left hover:bg-panel-2 focus:bg-panel-2 disabled:opacity-50';
const sub = `${item} pl-5`;
</script>

<template>
  <div
    ref="root"
    class="fixed z-30 max-h-[80vh] min-w-[220px] overflow-y-auto rounded-md border border-border bg-panel p-1.5 shadow-popover"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
    role="menu"
    :aria-label="`Task #${task.id}`"
    data-row-menu
    @contextmenu.prevent
  >
    <button :class="item" role="menuitem" @click="done(() => emit('open', task.id))">Open</button>
    <button v-if="task.pr_url" :class="item" role="menuitem" @click="done(() => openExternal(task.pr_url!))">Open PR ↗</button>

    <hr class="my-1 border-border" />
    <button :class="item" role="menuitem" :disabled="!editable" @click="toggle('priority')">Priority <span>▸</span></button>
    <template v-if="section === 'priority'">
      <button
        v-for="l in PRIORITY_LEVELS"
        :key="l.key"
        :class="sub"
        role="menuitemradio"
        :aria-checked="priorityLevel(task.priority) === l.key"
        @click="setPriority(levelPriority(l))"
      >
        {{ l.label }} <span v-if="priorityLevel(task.priority) === l.key">✓</span>
      </button>
    </template>
    <button :class="item" role="menuitem" :disabled="!editable" @click="toggle('model')">Model <span>▸</span></button>
    <template v-if="section === 'model'">
      <button v-for="m in MODELS" :key="m" :class="sub" role="menuitemradio" :aria-checked="task.model === m" @click="setModel(m)">
        {{ m }} <span v-if="task.model === m">✓</span>
      </button>
    </template>
    <button :class="item" role="menuitem" :disabled="!editable" @click="toggle('link')">Link <span>▸</span></button>
    <div v-if="section === 'link'" class="flex flex-col gap-1 py-1 pr-2 pl-5">
      <input
        v-model="linkTo"
        class="px-1.5 py-0.5"
        placeholder="#id of the other task"
        aria-label="Task to link"
        @keydown.enter="link('builds_on')"
      />
      <button class="px-2 py-0.5" @click="link('builds_on')">Builds on</button>
      <button class="px-2 py-0.5" @click="link('after')">After</button>
    </div>

    <hr class="my-1 border-border" />
    <button :class="item" role="menuitem" @click="copyText(branchName(task), 'branch name')">Copy branch name</button>
    <button :class="item" role="menuitem" @click="copyText(`#${task.id}`, `#${task.id}`)">Copy #{{ task.id }}</button>

    <template v-if="events.length || canReview(task)">
      <hr class="my-1 border-border" />
      <button v-for="e in events" :key="e" :class="item" role="menuitem" @click="done(() => emit('act', e, task.id))">
        {{ LABELS[e] }}
      </button>
      <button v-if="canReview(task)" :class="item" role="menuitem" @click="done(() => emit('merge', task.id))">Merge…</button>
    </template>
  </div>
</template>
