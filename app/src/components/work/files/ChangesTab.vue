<script setup lang="ts">
import { ago } from '#lib/shared/time.ts';
import type { Changes, TaskDetail } from '#api/types.ts';
import { plural } from '#daemon/domain/shared/index.ts';
import { useChangesTab } from '#composables/work/files/useChangesTab.ts';
import { SINCE_BASE, sinceKey, sinceLabel } from '#lib/work/files/since.ts';
import FileTree from '#components/work/files/FileTree.vue';
import Checkbox from '#components/ui/form/Checkbox.vue';
import Delta from '#components/ui/status/Delta.vue';
import Menu from '#components/ui/menu/Menu.vue';
import MenuRadioGroup from '#components/ui/menu/MenuRadioGroup.vue';
import MenuRadioItem from '#components/ui/menu/MenuRadioItem.vue';
import Popover from '#components/ui/Popover.vue';
import SegmentedControl from '#components/ui/form/SegmentedControl.vue';
import ChangedFileCard from '#components/work/files/ChangedFileCard.vue';

const props = defineProps<{ task: TaskDetail; changes: Changes | null; error: string }>();
const emit = defineEmits<{ open: [path: string] }>();
const {
  picked,
  point,
  shown,
  sinceError,
  files,
  totals,
  listed,
  split,
  hideViewed,
  openPaths,
  commentsOn,
  addComment,
  isViewed,
  markViewed,
  collapsed,
  patches,
  sectionRef,
  preview,
  previewOn,
  togglePreview,
  loadTree,
  current,
  jump,
} = useChangesTab(props);
</script>

<template>
  <div class="flex flex-col">
    <p v-if="error" class="py-2 text-muted">{{ error }}</p>
    <p v-else-if="!changes" class="py-2 text-muted">Loading changes…</p>
    <template v-else>
      <div v-if="files.length || changes.since_points.length" class="flex items-center gap-2 pb-2.5">
        <Menu v-if="changes.since_points.length" label="Show the changes since">
          <template #trigger
            ><button class="btn-mini">{{ point ? sinceLabel(point) : `Against ${changes.base_ref}` }} ▾</button></template
          >
          <MenuRadioGroup :model-value="point ? sinceKey(point) : SINCE_BASE" @update:model-value="(v) => (picked = v)">
            <MenuRadioItem :value="SINCE_BASE"
              ><span class="flex-1">Against {{ changes.base_ref }}</span></MenuRadioItem
            >
            <MenuRadioItem v-for="p in changes.since_points" :key="sinceKey(p)" :value="sinceKey(p)">
              <span class="flex-1">{{ sinceLabel(p) }}</span>
              <span class="text-sm text-muted">{{ ago(p.at) }}</span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </Menu>
        <template v-if="shown && files.length">
          <b>{{ plural(files.length, 'file') }}</b>
          <Delta class="text-sm" :add="totals.add" :del="totals.del" />
          <Popover>
            <template #trigger
              ><button class="btn-mini">{{ plural(shown.commits.length, 'commit') }} ▾</button></template
            >
            <div v-for="c in shown.commits" :key="c.sha" class="flex gap-2 px-2 py-1 text-sm whitespace-nowrap">
              <code>{{ c.sha.slice(0, 7) }}</code>
              <span class="max-w-[380px] flex-1 truncate">{{ c.subject }}</span>
              <span class="text-muted">{{ ago(c.at) }}</span>
            </div>
          </Popover>
          <div class="spacer" />
          <Checkbox v-model="hideViewed">Hide viewed</Checkbox>
          <SegmentedControl
            label="Diff layout"
            :options="[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]"
            :model-value="split ? 'split' : 'unified'"
            @update:model-value="(v) => (split = v === 'split')"
          />
        </template>
      </div>
      <p v-if="sinceError" class="py-2 text-muted">{{ sinceError }}</p>
      <p v-else-if="!shown" class="py-2 text-muted">Loading changes…</p>
      <p v-else-if="!files.length" class="py-2 text-muted">
        <template v-if="point">No changes since then.</template>
        <template v-else
          >No changes against <code>{{ changes.base_ref }}</code> yet.</template
        >
      </p>
      <p v-if="shown?.base_may_show" class="pb-2.5 text-sm text-muted">
        Merging <code>{{ shown.base_ref }}</code> into that point conflicts, so changes a sync brought in from it may show here.
      </p>
      <div v-if="shown && files.length" class="flex items-start gap-4">
        <aside class="sticky top-0 h-[calc(100cqh-1.5rem)] min-h-0 w-65 flex-none pb-4 max-md:hidden">
          <FileTree
            :load="loadTree"
            :selected="current"
            :commented="openPaths"
            expand-all
            :known="files.map((f) => f.path)"
            @select="jump"
          />
        </aside>
        <div class="min-w-0 flex-1">
          <ChangedFileCard
            v-for="f in listed"
            :key="f.path"
            :ref="sectionRef"
            :file="f"
            :patch="patches.get(f.path)"
            :split="split"
            :viewed="isViewed(f)"
            :preview="previewOn.has(f.path) ? (preview.get(f.path) ?? null) : undefined"
            :comments="commentsOn(f.path)"
            :add="(line, body) => addComment(f.path, line, body)"
            :open="!collapsed.has(f.path)"
            @update:open="(o) => (o ? collapsed.delete(f.path) : collapsed.add(f.path))"
            @update:viewed="(v) => markViewed(f, v)"
            @preview="togglePreview(f.path)"
            @view="emit('open', f.path)"
          />
          <p v-if="!listed.length" class="py-2 text-muted">Every file is marked viewed.</p>
        </div>
      </div>
    </template>
  </div>
</template>
