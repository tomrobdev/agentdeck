<script setup lang="ts">
import { computed } from 'vue';
import { workApi } from '#api/work.ts';
import type { TaskDetail } from '#api/types.ts';
import { canEdit } from '#lib/work/task-view.ts';
import { openExternal } from '#platform/native.ts';
import { useActions } from '#composables/shared/useActions.ts';
import InlineEdit from '#components/ui/form/InlineEdit.vue';
import IssueChip from '#components/ui/status/IssueChip.vue';

const props = defineProps<{ task: TaskDetail }>();
const { run } = useActions();

const issue = computed(() => props.task.issue ?? null);
const editable = computed(() => canEdit(props.task) && !issue.value);

async function save(text: string) {
  const t = text.trim();
  if (!t || t === props.task.title) return;
  await run(() => workApi.editTask(props.task.id, { title: t }));
}
</script>

<template>
  <div class="flex min-w-0 items-baseline gap-2">
    <span class="flex-none font-mono text-xl text-muted">#{{ task.id }}</span>
    <IssueChip :issue="issue" class="self-center" />
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
    <button
      v-if="issue && canEdit(task)"
      class="btn-ghost flex-none px-2 py-0 text-sm"
      :title="`The title and prompt are issue #${issue.number}'s`"
      data-edit-on-github
      @click="openExternal(issue.url)"
    >
      Edit on GitHub ↗
    </button>
  </div>
</template>
