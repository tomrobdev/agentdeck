<script setup lang="ts">
import { computed } from 'vue';
import { workApi } from '#api/work.ts';
import type { TaskDetail } from '#api/types.ts';
import { canEdit } from '#lib/work/task-view.ts';
import { useActions } from '#composables/shared/useActions.ts';
import InlineEdit from '#components/ui/form/InlineEdit.vue';

const props = defineProps<{ task: TaskDetail }>();
const { run } = useActions();

const editable = computed(() => canEdit(props.task) && !props.task.issue);

async function save(text: string) {
  const t = text.trim();
  if (!t || t === props.task.title) return;
  await run(() => workApi.editTask(props.task.id, { title: t }));
}
</script>

<template>
  <h1 class="m-0 min-w-0 text-xl leading-[1.3] font-semibold wrap-anywhere">
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
</template>
