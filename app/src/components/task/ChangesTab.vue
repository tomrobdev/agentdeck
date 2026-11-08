<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { type ChangedFile, type Changes, type NewReviewComment, type TaskDetail, ago, api, changesSinceQuery } from '../../api';
import { plural } from '../../../../daemon/src/domain/shared/index.ts';
import { useActions } from '../../composables/useActions';
import { useFilePatches } from '../../composables/useFilePatches';
import { useFileText } from '../../composables/useFileText';
import { useHotkeys } from '../../composables/useHotkeys';
import { useReviews } from '../../composables/useReviews';
import { useViewed } from '../../composables/useViewed';
import { changedTree } from '../../lib/changedTree';
import { openCommentOrder, stepFrom } from '../../lib/reviewNav';
import { SINCE_BASE, shownSince, sinceKey, sinceLabel } from '../../lib/since';
import { loadSetting, saveSetting } from '../../lib/storage';
import FileTree from '../files/FileTree.vue';
import Checkbox from '../ui/Checkbox.vue';
import Delta from '../ui/Delta.vue';
import Menu from '../ui/Menu.vue';
import MenuRadioGroup from '../ui/MenuRadioGroup.vue';
import MenuRadioItem from '../ui/MenuRadioItem.vue';
import Popover from '../ui/Popover.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import ChangedFileCard from './ChangedFileCard.vue';

// What the task's branch changes against the base branch, or since a person's last review or the end of an earlier run
// (the Since menu, which leaves out what a sync brought in from the base): a tree of changed files and their diffs.
const props = defineProps<{ task: TaskDetail; changes: Changes | null; error: string }>();
const emit = defineEmits<{ open: [path: string] }>();
const taskId = computed(() => props.task.id);

// The tab opens on the last review when the head has moved past it; a pick stays until another task is opened.
const picked = ref<string | null>(null);
watch(taskId, () => (picked.value = null));
const point = computed(() => shownSince(props.changes?.since_points ?? [], picked.value));
const since = computed(() => point.value?.sha ?? null);
const sinceQ = useQuery(
  computed(() => ({ ...changesSinceQuery(taskId.value, since.value ?? '', props.changes?.head ?? null), enabled: !!since.value })),
);
/** The changes on screen: against the base, or since the point picked (null while those load). */
const shown = computed<Changes | null>(() => {
  if (!since.value) return props.changes;
  const data = sinceQ.data.value;
  return data && data.since === since.value && data.head === props.changes?.head ? data : null;
});
const sinceError = computed(() => (since.value ? (sinceQ.error.value?.message ?? '') : ''));
const head = computed(() => shown.value?.head ?? null);

// Line comments go into the task's draft review (started with the first one); the review bar submits it. Since a point, the
// old side is that point's file, not the base's, so only the new side's comments show there and only it takes new ones.
const { run } = useActions();
const { byPath, openPaths, comments } = useReviews(taskId);
const commentsOn = (path: string) => (since.value ? byPath.value.get(path)?.filter((c) => c.side === 'new') : byPath.value.get(path));
function addComment(path: string, line: Pick<NewReviewComment, 'side' | 'line'>, body: string) {
  const head = shown.value?.head;
  if (!head) return Promise.resolve(false);
  return run(async () => {
    if (since.value && line.side === 'old')
      throw new Error(`Comment on a removed line in the changes against ${shown.value?.base_ref ?? 'the base'}`);
    const review = await api.startReview(props.task.id);
    await api.addComment(review.id, { path, ...line, head_commit: head, body });
  });
}

const split = ref(loadSetting('diffSplit', false));
const hideViewed = ref(false);
watch(split, (v) => saveSetting('diffSplit', v));

const files = computed(() => shown.value?.files ?? []);
const totals = computed(() => files.value.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }));

const { isViewed, setViewed } = useViewed(taskId);
function markViewed(f: ChangedFile, on: boolean) {
  setViewed(f, on);
  if (on) collapsed.add(f.path);
  else collapsed.delete(f.path);
}

const collapsed = reactive(new Set<string>());
const listed = computed(() => files.value.filter((f) => !(hideViewed.value && isViewed(f))));

const { patches, sectionRef } = useFilePatches(taskId, head, since);
const { text: preview, load: loadPreview } = useFileText(taskId, head);
const previewOn = reactive(new Set<string>());
watch(
  [head, since],
  () => {
    previewOn.clear();
    for (const f of files.value) if (isViewed(f)) collapsed.add(f.path);
  },
  { immediate: true },
);

function togglePreview(path: string) {
  if (previewOn.has(path)) return previewOn.delete(path);
  previewOn.add(path);
  void loadPreview(path);
}

const loadTree = computed(() => {
  const tree = changedTree(files.value);
  return async (dir: string) => tree.get(dir) ?? [];
});

const current = ref<string | null>(null);
async function jump(path: string) {
  current.value = path;
  collapsed.delete(path);
  await nextTick();
  document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' });
}

// Keys: j and k move to the next and previous file, ] and [ to the next and previous open comment, v marks the file viewed.
async function scrollToComment(id: number, path: string) {
  current.value = path;
  collapsed.delete(path);
  await nextTick();
  document.querySelector(`[data-comment="${id}"]`)?.scrollIntoView({ block: 'center' });
}
let currentComment: number | null = null;
function stepComment(by: 1 | -1) {
  const list = openCommentOrder(
    comments.value,
    files.value.map((f) => f.path),
  );
  const at = list.find((c) => c.id === currentComment) ?? null;
  const next = stepFrom(list, at, by);
  if (!next) return;
  currentComment = next.id;
  void scrollToComment(next.id, next.path);
}
function stepFile(by: 1 | -1) {
  const paths = files.value.map((f) => f.path);
  const next = stepFrom(paths, current.value, by);
  if (next) void jump(next);
}
function toggleViewed() {
  const f = files.value.find((x) => x.path === current.value);
  if (f) markViewed(f, !isViewed(f));
}
useHotkeys({ j: () => stepFile(1), k: () => stepFile(-1), ']': () => stepComment(1), '[': () => stepComment(-1), v: toggleViewed });
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
        <!-- The page scrolls as one; the tree sticks beside the diffs at the scroller's height (TaskPage makes it a size container). -->
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
