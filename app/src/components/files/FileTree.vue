<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useHotkeys } from '../../composables/useHotkeys';
import Delta from '../ui/Delta.vue';

/** A tree node. `meta` is shown at the row end (e.g. "bin"), `delta` as +n −n counts; `badge` before the name (A, M, D, R). */
export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  badge?: string;
  badgeTitle?: string;
  meta?: string;
  delta?: { add: number; del: number };
}

// A file tree that loads folders through `load`, so the same component serves the changed files
// (all known up front) and a repo browsed one level at a time.
const props = defineProps<{
  load: (dir: string) => Promise<TreeNode[]>;
  selected: string | null;
  /** Paths to mark with a dot, such as the files a task changed. */
  marks?: Set<string>;
  /** Paths with open review comments, marked with a dot. */
  commented?: Set<string>;
  /** Folders to open at the start, and whenever `selected` changes, its parents. */
  expandAll?: boolean;
  /** Extra paths the filter can find although their folders aren't loaded. */
  known?: string[];
}>();
const emit = defineEmits<{ select: [path: string] }>();

const children = reactive(new Map<string, TreeNode[]>());
const open = reactive(new Set<string>());
const loading = reactive(new Set<string>());
const error = ref('');
const filter = ref('');
const filterBox = ref<HTMLInputElement | null>(null);

// In-flight loads, so a second caller waits for the first instead of seeing an empty folder.
const pending = new Map<string, Promise<void>>();
function ensure(dir: string): Promise<void> {
  if (children.has(dir)) return Promise.resolve();
  if (!pending.has(dir))
    pending.set(
      dir,
      fetchDir(dir).finally(() => pending.delete(dir)),
    );
  return pending.get(dir)!;
}
async function fetchDir(dir: string) {
  const load = props.load;
  loading.add(dir);
  try {
    const list = await load(dir);
    if (load !== props.load) return; // another task or ref took over meanwhile
    children.set(dir, list);
    if (props.expandAll) for (const n of list) if (n.type === 'dir') await toggle(n.path, true);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.delete(dir);
  }
}

async function toggle(dir: string, force?: boolean) {
  const opening = force ?? !open.has(dir);
  if (opening) {
    open.add(dir);
    await ensure(dir);
  } else open.delete(dir);
}

// Reset when the loader changes (another task or ref).
watch(
  () => props.load,
  () => {
    children.clear();
    open.clear();
    pending.clear();
    error.value = '';
    ensure('');
    revealSelected();
  },
  { immediate: true },
);

/** Open the folders above the selected file, so it's visible. */
async function revealSelected() {
  const p = props.selected;
  if (!p) return;
  const parts = p.split('/');
  let dir = '';
  for (const part of parts.slice(0, -1)) {
    dir = dir ? `${dir}/${part}` : part;
    // Compressed folders ("daemon/src") are one node; only open paths that exist as nodes.
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    await ensure(parent);
    if ([...children.values()].some((list) => list.some((n) => n.path === dir && n.type === 'dir'))) await toggle(dir, true);
  }
}
watch(() => props.selected, revealSelected);

interface Row {
  node: TreeNode;
  depth: number;
}
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    for (const node of children.get(dir) ?? []) {
      out.push({ node, depth });
      if (node.type === 'dir' && open.has(node.path)) walk(node.path, depth + 1);
    }
  };
  walk('', 0);
  return out;
});

/** With a filter, a flat list of matching files among everything loaded or known. */
const matches = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return null;
  const files = new Set<string>(props.known ?? []);
  for (const list of children.values()) for (const n of list) if (n.type === 'file') files.add(n.path);
  return [...files]
    .filter((p) => fuzzy(p.toLowerCase(), q))
    .sort((a, b) => a.length - b.length)
    .slice(0, 200);
});
/** Each character of q appears in order in s. */
function fuzzy(s: string, q: string): boolean {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

const ROW = 'flex w-full items-center gap-[5px] rounded-sm border-none bg-transparent px-2 py-0.5 text-left text-sm whitespace-nowrap';
const SELECTED = 'bg-[color-mix(in_srgb,var(--accent)_14%,var(--panel))]';

useHotkeys({ t: () => filterBox.value?.focus() });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <input
      ref="filterBox"
      v-model="filter"
      class="mb-1.5 px-2 py-[3px]"
      type="search"
      placeholder="Go to file  t"
      @keydown.esc="filter = ''"
    />
    <p v-if="error" class="text-sm text-failed">{{ error }}</p>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <template v-if="matches">
        <button
          v-for="p in matches"
          :key="p"
          :class="[ROW, p === selected ? SELECTED : 'hover:bg-panel-2']"
          :title="p"
          @click="(emit('select', p), (filter = ''))"
        >
          <span class="flex-1 truncate">{{ p }}</span>
        </button>
        <p v-if="!matches.length" class="text-muted px-2 py-1 text-sm">No loaded file matches.</p>
      </template>
      <template v-else>
        <button
          v-for="r in rows"
          :key="r.node.path"
          :class="[ROW, r.node.path === selected ? SELECTED : 'hover:bg-panel-2']"
          :style="{ paddingLeft: `${8 + r.depth * 14}px` }"
          :title="r.node.path"
          @click="r.node.type === 'dir' ? toggle(r.node.path) : emit('select', r.node.path)"
        >
          <span class="w-2.5 flex-none text-2xs text-muted">{{ r.node.type === 'dir' ? (open.has(r.node.path) ? '▾' : '▸') : '' }}</span>
          <span v-if="r.node.badge" class="badge" :class="`b-${r.node.badge}`" :title="r.node.badgeTitle">{{ r.node.badge }}</span>
          <span class="flex-1 truncate" :class="r.node.type === 'dir' ? 'font-medium' : ''">{{ r.node.name }}</span>
          <span v-if="commented?.has(r.node.path)" class="text-xs text-accent" title="Open review comments">●</span>
          <span v-if="marks?.has(r.node.path)" class="text-[8px] text-blocked" title="Changed by this task">●</span>
          <span v-if="r.node.meta" class="font-mono text-xs text-muted">{{ r.node.meta }}</span>
          <Delta v-if="r.node.delta" class="text-xs" :add="r.node.delta.add" :del="r.node.delta.del" />
          <span v-if="loading.has(r.node.path)" class="text-muted">…</span>
        </button>
        <p v-if="!rows.length && !loading.size && !error" class="text-muted px-2 py-1 text-sm">Empty.</p>
      </template>
    </div>
  </div>
</template>
