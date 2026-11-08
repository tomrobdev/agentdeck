<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { type ChangedFile, type Changes, type NewReviewComment, type TaskDetail, ago, api } from '../../api';
import { plural } from '../../../../daemon/src/domain/shared/index.ts';
import { useActions } from '../../composables/useActions';
import { useFilePatches } from '../../composables/useFilePatches';
import { useFileText } from '../../composables/useFileText';
import { useHotkeys } from '../../composables/useHotkeys';
import { useReviews } from '../../composables/useReviews';
import { useViewed } from '../../composables/useViewed';
import { changedTree } from '../../lib/changedTree';
import { openCommentOrder, stepFrom } from '../../lib/reviewNav';
import { loadSetting, saveSetting } from '../../lib/storage';
import FileTree from '../files/FileTree.vue';
import Checkbox from '../ui/Checkbox.vue';
import Delta from '../ui/Delta.vue';
import Popover from '../ui/Popover.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import ChangedFileCard from './ChangedFileCard.vue';

// What the task's branch changes against the base branch: a tree of changed files and their diffs.
const props = defineProps<{ task: TaskDetail; changes: Changes | null; error: string }>();
const emit = defineEmits<{ open: [path: string] }>();
const taskId = computed(() => props.task.id);
const head = computed(() => props.changes?.head ?? null);

// Line comments go into the task's draft review (started with the first one); the review bar submits it.
const { run } = useActions();
const { byPath, openPaths, comments } = useReviews(taskId);
function addComment(path: string, line: Pick<NewReviewComment, 'side' | 'line'>, body: string) {
  const head = props.changes?.head;
  if (!head) return Promise.resolve(false);
  return run(async () => {
    const review = await api.startReview(props.task.id);
    await api.addComment(review.id, { path, ...line, head_commit: head, body });
  });
}

const split = ref(loadSetting('diffSplit', false));
const hideViewed = ref(false);
watch(split, (v) => saveSetting('diffSplit', v));

const files = computed(() => props.changes?.files ?? []);
const totals = computed(() => files.value.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }));

const { isViewed, setViewed } = useViewed(taskId);
function markViewed(f: ChangedFile, on: boolean) {
  setViewed(f, on);
  if (on) collapsed.add(f.path);
  else collapsed.delete(f.path);
}

const collapsed = reactive(new Set<string>());
const shown = computed(() => files.value.filter((f) => !(hideViewed.value && isViewed(f))));

const { patches, sectionRef } = useFilePatches(taskId, head);
const { text: preview, load: loadPreview } = useFileText(taskId, head);
const previewOn = reactive(new Set<string>());
watch(
  head,
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
    shown.value.map((f) => f.path),
  );
  const at = list.find((c) => c.id === currentComment) ?? null;
  const next = stepFrom(list, at, by);
  if (!next) return;
  currentComment = next.id;
  void scrollToComment(next.id, next.path);
}
function stepFile(by: 1 | -1) {
  const paths = shown.value.map((f) => f.path);
  const next = stepFrom(paths, current.value, by);
  if (next) void jump(next);
}
function toggleViewed() {
  const f = shown.value.find((x) => x.path === current.value);
  if (f) markViewed(f, !isViewed(f));
}
useHotkeys({ j: () => stepFile(1), k: () => stepFile(-1), ']': () => stepComment(1), '[': () => stepComment(-1), v: toggleViewed });
</script>

<template>
  <div class="flex flex-col">
    <p v-if="error" class="py-2 text-muted">{{ error }}</p>
    <p v-else-if="!changes" class="py-2 text-muted">Loading changes…</p>
    <p v-else-if="!files.length" class="py-2 text-muted">
      No changes against <code>{{ changes.base_ref }}</code> yet.
    </p>
    <template v-else>
      <div class="flex items-center gap-2 pb-2.5">
        <b>{{ plural(files.length, 'file') }}</b>
        <Delta class="text-sm" :add="totals.add" :del="totals.del" />
        <Popover>
          <template #trigger
            ><button class="btn-mini">{{ plural(changes.commits.length, 'commit') }} ▾</button></template
          >
          <div v-for="c in changes.commits" :key="c.sha" class="flex gap-2 px-2 py-1 text-sm whitespace-nowrap">
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
      </div>
      <div class="flex items-start gap-4">
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
            v-for="f in shown"
            :key="f.path"
            :ref="sectionRef"
            :file="f"
            :patch="patches.get(f.path)"
            :split="split"
            :viewed="isViewed(f)"
            :preview="previewOn.has(f.path) ? (preview.get(f.path) ?? null) : undefined"
            :comments="byPath.get(f.path)"
            :add="(line, body) => addComment(f.path, line, body)"
            :open="!collapsed.has(f.path)"
            @update:open="(o) => (o ? collapsed.delete(f.path) : collapsed.add(f.path))"
            @update:viewed="(v) => markViewed(f, v)"
            @preview="togglePreview(f.path)"
            @view="emit('open', f.path)"
          />
          <p v-if="!shown.length" class="py-2 text-muted">Every file is marked viewed.</p>
        </div>
      </div>
    </template>
  </div>
</template>
