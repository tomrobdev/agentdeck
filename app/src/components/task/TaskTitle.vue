<script setup lang="ts">
import { computed, ref } from 'vue';
import { type TaskDetail, api } from '../../api';
import { canEdit } from '../../lib/taskView';
import { useActions } from '../../composables/useActions';

// The task's number and title, the title edited in place while the task is editable.
const props = defineProps<{ task: TaskDetail }>();
const { run } = useActions();

const editing = ref(false);
const draft = ref('');
const editable = computed(() => canEdit(props.task));

function edit() {
  if (!editable.value) return;
  draft.value = props.task.title;
  editing.value = true;
}
async function save() {
  if (!editing.value) return;
  editing.value = false;
  const t = draft.value.trim();
  if (!t || t === props.task.title) return;
  await run(() => api.editTask(props.task.id, { title: t }));
}
</script>

<template>
  <div class="flex min-w-0 items-baseline gap-2">
    <span class="flex-none font-mono text-xl text-muted">#{{ task.id }}</span>
    <h1
      v-if="!editing"
      class="m-0 min-w-0 flex-1 text-xl leading-[1.3] font-semibold wrap-anywhere"
      :class="editable && 'cursor-text'"
      :title="editable ? 'Click to edit' : ''"
      @click="edit"
    >
      {{ task.title }}
    </h1>
    <input
      v-else
      v-model="draft"
      class="min-w-0 flex-1 text-xl font-semibold"
      autofocus
      @keydown.enter="save"
      @keydown.esc.prevent="editing = false"
      @blur="save"
    />
  </div>
</template>
