<script setup lang="ts">
import { ref } from 'vue';
import type { TaskSummary } from '#api/types.ts';
import { useActions } from '#composables/shared/useActions.ts';
import type { BulkAction, BulkEdit } from '#lib/work/queue/bulk.ts';
import type { BulkEditValue } from '#composables/work/queue/useBulkEdit.ts';
import { MODELS } from '#daemon/domain/work/index.ts';
import { PRIORITY_LEVELS, levelPriority } from '#lib/work/task-view.ts';
import Menu from '#components/ui/menu/Menu.vue';
import MenuItem from '#components/ui/menu/MenuItem.vue';
import MenuSeparator from '#components/ui/menu/MenuSeparator.vue';
import MenuSub from '#components/ui/menu/MenuSub.vue';

defineProps<{ count: number; actions: BulkAction[]; busy: boolean; others: Pick<TaskSummary, 'id' | 'title'>[] }>();
const { flash } = useActions();
const emit = defineEmits<{
  act: [action: BulkAction];
  edit: [edit: BulkEdit, value: BulkEditValue, label: string, on?: number];
  clear: [];
}>();

const LABELS: Record<BulkAction, string> = { approve: 'Approve', reject: 'Reject', retry: 'Retry', merge: 'Merge', cancel: 'Cancel' };
const AUTO_MERGE = [
  { label: "The repo's setting", value: null },
  { label: 'On', value: true },
  { label: 'Off', value: false },
] as const;

const open = ref(false);
const linkTo = ref('');
const linkInput = ref<HTMLInputElement | null>(null);
const linkId = () => Number(/^#?(\d+)/.exec(linkTo.value.trim())?.[1] ?? 0);
function link(kind: 'builds_on' | 'after', e?: Event) {
  const on = linkId();
  if (on < 1) {
    e?.preventDefault();
    return flash('Enter the task to link as #id');
  }
  emit('edit', kind, null, '', on);
  open.value = false;
  linkTo.value = '';
}
</script>

<template>
  <div class="flex items-center gap-2 border-t border-border bg-panel-2 px-4 py-2" role="toolbar" aria-label="Selected tasks">
    <span class="font-semibold">{{ count }} selected</span>
    <button v-for="a in actions" :key="a" class="btn-mini" :disabled="busy" @click="emit('act', a)">{{ LABELS[a] }}</button>
    <span v-if="!actions.length" class="text-muted text-sm">No action fits all of them</span>
    <Menu v-model:open="open" label="Edit selected tasks">
      <template #trigger>
        <button class="btn-mini" :disabled="busy" aria-haspopup="menu">Edit…</button>
      </template>
      <MenuSub label="Priority">
        <MenuItem v-for="l in PRIORITY_LEVELS" :key="l.key" @select="emit('edit', 'priority', levelPriority(l), l.label.toLowerCase())">
          {{ l.label }}
        </MenuItem>
      </MenuSub>
      <MenuSub label="Model">
        <MenuItem v-for="m in MODELS" :key="m" @select="emit('edit', 'model', m, m)">{{ m }}</MenuItem>
      </MenuSub>
      <MenuSub label="Auto-merge">
        <MenuItem v-for="o in AUTO_MERGE" :key="o.label" @select="emit('edit', 'auto_merge', o.value, o.label.toLowerCase())">
          {{ o.label }}
        </MenuItem>
      </MenuSub>
      <MenuSeparator />
      <MenuSub label="Link" @opened="linkInput?.focus()">
        <input
          ref="linkInput"
          v-model="linkTo"
          list="bulk-link-tasks"
          class="mb-1 w-full px-1.5 py-0.5"
          placeholder="#id of the other task"
          aria-label="Task to link"
          @keydown.stop
          @keydown.enter="link('builds_on')"
        />
        <datalist id="bulk-link-tasks">
          <option v-for="t in others" :key="t.id" :value="`#${t.id} ${t.title}`" />
        </datalist>
        <MenuItem @select="link('builds_on', $event)">Builds on…</MenuItem>
        <MenuItem @select="link('after', $event)">After…</MenuItem>
      </MenuSub>
    </Menu>
    <span class="flex-1" />
    <button class="btn-mini" title="Clear (Esc)" @click="emit('clear')">Clear</button>
  </div>
</template>
