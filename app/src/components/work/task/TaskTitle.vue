<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../../../api/client';
import type { TaskDetail } from '../../../api/types';
import { canEdit } from '../../../lib/work/task-view';
import { useActions } from '../../../composables/shared/useActions';
import InlineEdit from '../../ui/form/InlineEdit.vue';

// The task's number and title, the title edited in place while the task is editable.
const props = defineProps<{ task: TaskDetail }>();
const { run } = useActions();

const editable = computed(() => canEdit(props.task));

async function save(text: string) {
  const t = text.trim();
  if (!t || t === props.task.title) return;
  await run(() => api.editTask(props.task.id, { title: t }));
}
</script>

<template>
  <div class="flex min-w-0 items-baseline gap-2">
    <span class="flex-none font-mono text-xl text-muted">#{{ task.id }}</span>
    <h1 class="m-0 min-w-0 flex-1 text-xl leading-[1.3] font-semibold wrap-anywhere">
      <InlineEdit
        v-if="editable"
        label="Title"
        :value="task.title"
        preview-class="cursor-text"
        input-class="min-w-0 flex-1 text-xl font-semibold"
        @submit="save"
      />
      <template v-else>{{ task.title }}</template>
    </h1>
  </div>
</template>
