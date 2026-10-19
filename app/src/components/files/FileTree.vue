<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

/** A tree node. `meta` is shown at the row end (e.g. "+24 −3"); `badge` before the name (A, M, D, R). */
export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  badge?: string;
  meta?: string;
}

// A file tree that loads folders through `load`, so the same component serves the changed files
// (all known up front) and a repo browsed one level at a time.
const props = defineProps<{
  load: (dir: string) => Promise<TreeNode[]>;
  selected: string | null;
  /** Paths to mark with a dot, such as the files a task changed. */
  marks?: Set<string>;
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

async function ensure(dir: string) {
  if (children.has(dir) || loading.has(dir)) return;
  loading.add(dir);
  try {
    const list = await props.load(dir);
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

function onKey(e: KeyboardEvent) {
  if (e.key !== 't' || e.metaKey || e.ctrlKey) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  filterBox.value?.focus();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="tree">
    <input ref="filterBox" v-model="filter" class="filter" type="search" placeholder="Go to file  t" @keydown.esc="filter = ''" />
    <p v-if="error" class="err">{{ error }}</p>
    <div class="rows">
      <template v-if="matches">
        <button
          v-for="p in matches"
          :key="p"
          class="row file"
          :class="{ sel: p === selected }"
          :title="p"
          @click="(emit('select', p), (filter = ''))"
        >
          <span class="name">{{ p }}</span>
        </button>
        <p v-if="!matches.length" class="muted none">No loaded file matches.</p>
      </template>
      <template v-else>
        <button
          v-for="r in rows"
          :key="r.node.path"
          class="row"
          :class="[r.node.type, { sel: r.node.path === selected }]"
          :style="{ paddingLeft: `${8 + r.depth * 14}px` }"
          :title="r.node.path"
          @click="r.node.type === 'dir' ? toggle(r.node.path) : emit('select', r.node.path)"
        >
          <span class="icon">{{ r.node.type === 'dir' ? (open.has(r.node.path) ? '▾' : '▸') : '' }}</span>
          <span v-if="r.node.badge" class="badge" :class="`b-${r.node.badge}`">{{ r.node.badge }}</span>
          <span class="name">{{ r.node.name }}</span>
          <span v-if="marks?.has(r.node.path)" class="mark" title="Changed by this task">●</span>
          <span v-if="r.node.meta" class="meta">{{ r.node.meta }}</span>
          <span v-if="loading.has(r.node.path)" class="muted">…</span>
        </button>
        <p v-if="!rows.length && !loading.size && !error" class="muted none">Empty.</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.filter {
  margin: 0 0 6px;
  padding: 3px 8px;
}
.rows {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  border: none;
  border-radius: 5px;
  background: none;
  padding: 2px 8px;
  text-align: left;
  font-size: 12.5px;
  white-space: nowrap;
}
.row:hover {
  background: var(--panel-2);
}
.row.sel {
  background: color-mix(in srgb, var(--accent) 14%, var(--panel));
}
.icon {
  width: 10px;
  flex: none;
  color: var(--muted);
  font-size: 10px;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.dir .name {
  font-weight: 500;
}
.badge {
  font:
    10px ui-monospace,
    Menlo,
    monospace;
  width: 13px;
  text-align: center;
  border-radius: 3px;
  flex: none;
}
.b-A {
  color: var(--done);
}
.b-D {
  color: var(--failed);
}
.b-M {
  color: var(--blocked);
}
.b-R {
  color: var(--running);
}
.mark {
  color: var(--blocked);
  font-size: 8px;
}
.meta {
  font:
    11px ui-monospace,
    Menlo,
    monospace;
  color: var(--muted);
}
.none {
  padding: 4px 8px;
  font-size: 12px;
}
.err {
  color: var(--failed);
  font-size: 12px;
}
</style>
