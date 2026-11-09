<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../../api/client';
import type { LinkKind, TaskSummary } from '../../api/types';
import { useActions } from '../../composables/shared/useActions';
import { openExternal, useCopy } from '../../platform/native';
import {
  type PersonEvent,
  MODELS,
  PRIORITY_LEVELS,
  branchName,
  canEdit,
  canStartMerge,
  isReview,
  levelPriority,
  personEvents,
  priorityLevel,
} from '../../lib/task/task-view';
import Menu from '../ui/menu/Menu.vue';
import MenuItem from '../ui/menu/MenuItem.vue';
import MenuRadioGroup from '../ui/menu/MenuRadioGroup.vue';
import MenuRadioItem from '../ui/menu/MenuRadioItem.vue';
import MenuSeparator from '../ui/menu/MenuSeparator.vue';
import MenuSub from '../ui/menu/MenuSub.vue';

// The menu a row opens on right-click, the context-menu key or ⇧F10: the task's usual actions and properties. It opens at
// (x, y) as soon as it is mounted and says `close` when it is dismissed or something was chosen.
const props = defineProps<{ task: TaskSummary; x: number; y: number }>();
const emit = defineEmits<{ close: []; open: [id: number]; act: [kind: PersonEvent, id: number]; merge: [id: number] }>();
const { run, flash } = useActions();
const { copy } = useCopy();

const open = ref(true);
watch(open, (isOpen) => !isOpen && emit('close'));
const linkTo = ref('');
const linkInput = ref<HTMLInputElement | null>(null);
const editable = computed(() => canEdit(props.task));

const LABELS: Record<PersonEvent, string> = {
  approve: 'Approve',
  reject: 'Reject',
  retry: 'Retry',
  cancel: 'Cancel task',
  mark_done: 'Mark done',
};
// A done task with an open PR is sent back with a note from its page, so Retry is not offered here.
const events = computed(() => personEvents(props.task).filter((e) => !(e === 'retry' && isReview(props.task))));

function done(fn: () => unknown) {
  emit('close');
  return fn();
}
const cancelMerge = () => run(() => api.cancelMergeRequest(props.task.id));
function setPriority(key: string) {
  const level = PRIORITY_LEVELS.find((l) => l.key === key);
  if (level && key !== priorityLevel(props.task.priority))
    done(() => run(() => api.editTask(props.task.id, { priority: levelPriority(level) })));
}
const setModel = (model: string) => model !== props.task.model && done(() => run(() => api.editTask(props.task.id, { model })));
const copyText = (text: string, what: string) => done(async () => (await copy(text, what), flash(`Copied ${what}`)));

// A bad id keeps the menu open (preventDefault on the item's select) so the person can fix it.
async function link(kind: LinkKind, e?: Event) {
  const on = Number(linkTo.value.trim().replace(/^#/, ''));
  if (!Number.isInteger(on) || on < 1) {
    e?.preventDefault();
    return flash('Enter the task to link as #id');
  }
  emit('close');
  await run(() => api.linkTask(props.task.id, { on, kind }), {
    done: `#${props.task.id} ${kind === 'after' ? 'after' : 'builds on'} #${on}`,
  });
}
</script>

<template>
  <Menu v-model:open="open" :label="`Task #${task.id}`" :at="{ x, y }">
    <MenuItem @select="done(() => emit('open', task.id))">Open</MenuItem>
    <MenuItem v-if="task.pr_url" @select="done(() => openExternal(task.pr_url!))">Open PR ↗</MenuItem>

    <MenuSeparator />
    <MenuSub label="Priority" :disabled="!editable">
      <MenuRadioGroup :model-value="priorityLevel(task.priority)" @update:model-value="setPriority">
        <MenuRadioItem v-for="l in PRIORITY_LEVELS" :key="l.key" :value="l.key">{{ l.label }}</MenuRadioItem>
      </MenuRadioGroup>
    </MenuSub>
    <MenuSub label="Model" :disabled="!editable">
      <MenuRadioGroup :model-value="task.model" @update:model-value="setModel">
        <MenuRadioItem v-for="m in MODELS" :key="m" :value="m">{{ m }}</MenuRadioItem>
      </MenuRadioGroup>
    </MenuSub>
    <MenuSub label="Link" :disabled="!editable" @opened="linkInput?.focus()">
      <!-- keydown.stop: the menu's typeahead and arrow keys must not take the letters and digits typed here. -->
      <input
        ref="linkInput"
        v-model="linkTo"
        class="mb-1 w-full px-1.5 py-0.5"
        placeholder="#id of the other task"
        aria-label="Task to link"
        @keydown.stop
        @keydown.enter="link('builds_on')"
      />
      <MenuItem @select="link('builds_on', $event)">Builds on</MenuItem>
      <MenuItem @select="link('after', $event)">After</MenuItem>
    </MenuSub>

    <MenuSeparator />
    <MenuItem @select="copyText(branchName({ id: task.id, checkout: { branch: task.branch } }), 'branch name')">Copy branch name</MenuItem>
    <MenuItem @select="copyText(`#${task.id}`, `#${task.id}`)">Copy #{{ task.id }}</MenuItem>

    <template v-if="events.length || isReview(task)">
      <MenuSeparator />
      <MenuItem v-for="e in events" :key="e" @select="done(() => emit('act', e, task.id))">{{ LABELS[e] }}</MenuItem>
      <MenuItem v-if="isReview(task)" :disabled="!canStartMerge(task)" @select="done(() => emit('merge', task.id))"> Merge… </MenuItem>
      <MenuItem v-if="isReview(task) && task.merge_request" @select="done(cancelMerge)">Cancel merge</MenuItem>
    </template>
  </Menu>
</template>
