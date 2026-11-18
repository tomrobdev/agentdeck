<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { fileSize } from '#lib/work/work-wording.ts';
import { fileQuery, treeQuery } from '#api/work.ts';
import { type FileRef, TEXT_LIMIT, type TaskDetail } from '#api/types.ts';
import { useCommits } from '#composables/work/files/useChanges.ts';
import { useCopy } from '#platform/native.ts';
import { isMarkdown as isMarkdownPath } from '#lib/shared/render.ts';
import { useRouter } from 'vue-router';
import CodeView, { type LineRange } from '#components/work/files/CodeView.vue';
import type { TreeNode } from '#lib/work/files/changed-tree.ts';
import FileTree from '#components/work/files/FileTree.vue';
import Markdown from '#components/ui/Markdown.vue';
import Chip from '#components/ui/Chip.vue';
import SegmentedControl from '#components/ui/form/SegmentedControl.vue';

const props = defineProps<{ task: TaskDetail; query: Record<string, string>; changed: Set<string> }>();

const router = useRouter();
const taskId = computed(() => props.task.id);
const ref_ = computed<FileRef>(() => (props.query.ref === 'base' ? 'base' : 'head'));
const path = computed(() => props.query.path ?? null);
const range = computed<LineRange | null>(() => {
  const m = props.query.L?.match(/^(\d+)(?:-(\d+))?$/);
  return m ? { from: Number(m[1]), to: Number(m[2] ?? m[1]) } : null;
});

function setQuery(patch: Record<string, string | null>, replace = false) {
  const query = { ...props.query, ...patch };
  for (const k of Object.keys(query)) if (query[k] === null) delete query[k];
  const to = { name: 'task', params: { id: taskId.value, tab: 'code' }, query: query as Record<string, string> } as const;
  void (replace ? router.replace(to) : router.push(to));
}

const queryClient = useQueryClient();
const { head, base } = useCommits(taskId);
const commit = computed(() => (ref_.value === 'base' ? base.value : head.value));

const loadTree = computed(() => {
  const id = taskId.value;
  const r = ref_.value;
  const sha = commit.value;
  return async (dir: string): Promise<TreeNode[]> =>
    (await queryClient.fetchQuery(treeQuery(id, r, dir, sha))).entries.map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type,
      meta: e.type === 'file' && e.size !== null && e.size > 100_000 ? fileSize(e.size) : undefined,
    }));
});

const fileQ = useQuery(
  computed(() => ({ ...fileQuery(taskId.value, ref_.value, path.value ?? '', commit.value), enabled: !!path.value && !!commit.value })),
);
const file = computed(() => (path.value ? (fileQ.data.value ?? null) : null));
const error = computed(() => (path.value ? (fileQ.error.value?.message ?? '') : ''));
const raw = ref(false);
watch([taskId, ref_, path], () => (raw.value = false));

const isMarkdown = computed(() => !!path.value && isMarkdownPath(path.value));
const isImage = computed(() => !!path.value && /\.(png|jpe?g|gif|webp|ico|icns)$/i.test(path.value));
const crumbs = computed(() => (path.value ?? '').split('/').filter(Boolean));
const { copied, copy } = useCopy();
const worktreePath = computed(() => (props.task.worktree && path.value ? `${props.task.worktree}/${path.value}` : null));
const select = (r: LineRange) => setQuery({ L: r.from === r.to ? String(r.from) : `${r.from}-${r.to}` }, true);
</script>

<template>
  <div class="flex min-h-0 flex-1 gap-4 pb-4">
    <aside class="flex min-h-0 w-70 flex-none flex-col gap-2 max-md:hidden">
      <SegmentedControl
        label="Version"
        :options="[
          { value: 'head', label: 'Task branch', title: task.branch ?? '' },
          { value: 'base', label: 'Base', title: 'Where the branch started' },
        ]"
        :model-value="ref_"
        @update:model-value="(v) => setQuery({ ref: v, L: null })"
      />
      <FileTree
        v-if="task.branch && commit"
        :load="loadTree"
        :selected="path"
        :marks="ref_ === 'head' ? changed : undefined"
        :known="[...changed]"
        @select="(p) => setQuery({ path: p, L: null })"
      />
      <p v-else class="text-muted">{{ task.branch ? 'Loading…' : 'No branch yet.' }}</p>
    </aside>
    <section class="card flex min-w-0 flex-1 flex-col">
      <p v-if="!path" class="p-6 text-muted">Pick a file. Press <kbd>t</kbd> to find one by name.</p>
      <template v-else>
        <header class="card-head px-2.5 py-1.5">
          <nav class="truncate font-mono text-sm leading-[normal]">
            <span v-for="(c, i) in crumbs" :key="i"
              ><span v-if="i" class="mx-[3px] text-muted">/</span><b v-if="i === crumbs.length - 1">{{ c }}</b
              ><span v-else>{{ c }}</span></span
            >
          </nav>
          <Chip v-if="changed.has(path) && ref_ === 'head'" tone="blocked" size="xs">changed</Chip>
          <span v-if="file" class="text-sm text-muted">{{ fileSize(file.size) }}</span>
          <div class="spacer" />
          <SegmentedControl
            v-if="isMarkdown && file?.text !== null"
            label="Markdown view"
            :options="[
              { value: 'preview', label: 'Preview' },
              { value: 'code', label: 'Code' },
            ]"
            :model-value="raw ? 'code' : 'preview'"
            @update:model-value="(v) => (raw = v === 'code')"
          />
          <button class="btn-mini" @click="copy(path, 'path')">{{ copied === 'path' ? 'Copied' : 'Copy path' }}</button>
          <button v-if="file?.text" class="btn-mini" @click="copy(file.text, 'text')">{{ copied === 'text' ? 'Copied' : 'Copy' }}</button>
          <button v-if="worktreePath" class="btn-mini" title="Copies the file's path in the worktree" @click="copy(worktreePath, 'wt')">
            {{ copied === 'wt' ? 'Copied' : 'Open in editor' }}
          </button>
        </header>
        <p v-if="error" class="m-0 px-3.5 py-3 text-muted">{{ error }}</p>
        <p v-else-if="!file" class="m-0 px-3.5 py-3 text-muted">Loading…</p>
        <p v-else-if="file.binary" class="m-0 px-3.5 py-3 text-muted">
          {{ isImage ? 'Image files aren’t shown yet.' : 'Binary file not shown.' }}
        </p>
        <div v-else-if="isMarkdown && !raw" class="flex-1 overflow-y-auto px-6.5 py-4.5"><Markdown :text="file.text ?? ''" /></div>
        <CodeView
          v-else
          class="min-h-0 flex-1 py-1.5"
          :text="file.text ?? ''"
          :path="path"
          :range="range"
          scroll-to-range
          @select="select"
        />
        <p v-if="file?.truncated" class="m-0 px-3.5 py-3 text-muted">File too large: showing the first {{ fileSize(TEXT_LIMIT) }}.</p>
      </template>
    </section>
  </div>
</template>
