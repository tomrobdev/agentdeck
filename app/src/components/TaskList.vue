<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { type TaskSummary, type TaskStatus, ago } from '../api';

const props = defineProps<{ tasks: TaskSummary[]; selected: number | null }>();
defineEmits<{ select: [id: number] }>();

/** A state a task can be in, finer than its status: a queued task may be waiting on --after, or stuck. */
interface Facet {
  key: string;
  label: string;
  test: (t: TaskSummary) => boolean;
}

const waiting = (t: TaskSummary) => t.status === 'queued' && !!t.waiting && !t.waiting.stuck;
const stuck = (t: TaskSummary) => t.status === 'queued' && !!t.waiting?.stuck;
const is =
  (...statuses: TaskStatus[]) =>
  (t: TaskSummary) =>
    statuses.includes(t.status);

const GROUPS: { key: string; label: string; facets: Facet[] }[] = [
  {
    key: 'active',
    label: 'Active',
    facets: [
      { key: 'running', label: 'Running', test: is('running', 'cancel_requested') },
      { key: 'queued', label: 'Queued', test: (t) => t.status === 'queued' && !t.waiting },
      { key: 'waiting', label: 'Waiting', test: waiting },
    ],
  },
  {
    key: 'review',
    label: 'Needs you',
    facets: [
      { key: 'proposed', label: 'Proposed', test: is('proposed') },
      { key: 'blocked', label: 'Blocked', test: is('blocked') },
      { key: 'failed', label: 'Failed', test: is('failed') },
      { key: 'stuck', label: 'Stuck', test: stuck },
    ],
  },
  {
    key: 'done',
    label: 'Done',
    facets: [
      { key: 'pr-open', label: 'PR open', test: (t) => t.status === 'done' && t.pr_state === 'open' },
      { key: 'pr-merged', label: 'Merged', test: (t) => t.status === 'done' && t.pr_state === 'merged' },
      { key: 'pr-closed', label: 'PR closed', test: (t) => t.status === 'done' && t.pr_state === 'closed' },
      { key: 'no-pr', label: 'No PR', test: (t) => t.status === 'done' && !t.pr_url },
    ],
  },
  {
    key: 'all',
    label: 'All',
    facets: [
      { key: 'running', label: 'Running', test: is('running', 'cancel_requested') },
      { key: 'queued', label: 'Queued', test: is('queued') },
      { key: 'proposed', label: 'Proposed', test: is('proposed') },
      { key: 'blocked', label: 'Blocked', test: is('blocked') },
      { key: 'failed', label: 'Failed', test: is('failed') },
      { key: 'done', label: 'Done', test: is('done') },
      { key: 'cancelled', label: 'Cancelled', test: is('cancelled') },
    ],
  },
];

const ORDER: Record<TaskStatus, number> = {
  running: 0,
  cancel_requested: 0,
  proposed: 1,
  blocked: 2,
  failed: 3,
  queued: 4,
  done: 5,
  cancelled: 6,
};

type Compare = (a: TaskSummary, b: TaskSummary) => number;
const SORTS: { key: string; label: string; compare: Compare }[] = [
  {
    key: 'attention',
    label: 'Needs attention',
    compare: (a, b) => ORDER[a.status] - ORDER[b.status] || b.priority - a.priority || b.id - a.id,
  },
  { key: 'updated', label: 'Recently updated', compare: (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id },
  { key: 'newest', label: 'Newest', compare: (a, b) => b.id - a.id },
  { key: 'oldest', label: 'Oldest', compare: (a, b) => a.id - b.id },
  { key: 'priority', label: 'Priority', compare: (a, b) => b.priority - a.priority || b.id - a.id },
];

/** The view choices are kept per browser; the search box is not. */
const STORE_KEY = 'agentdeck.taskList';
interface View {
  group: string;
  facets: string[];
  repo: string;
  sort: string;
}
function loadView(): View {
  const fallback: View = { group: 'all', facets: [], repo: '', sort: 'attention' };
  try {
    const v = { ...fallback, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
    if (!GROUPS.some((g) => g.key === v.group)) v.group = fallback.group;
    if (!SORTS.some((s) => s.key === v.sort)) v.sort = fallback.sort;
    if (!Array.isArray(v.facets)) v.facets = [];
    return v;
  } catch {
    return fallback;
  }
}

const saved = loadView();
const group = ref(saved.group);
const facets = ref<string[]>(saved.facets);
const repo = ref(saved.repo);
const sort = ref(saved.sort);
const query = ref('');
const search = ref<HTMLInputElement | null>(null);

watch([group, facets, repo, sort], () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ group: group.value, facets: facets.value, repo: repo.value, sort: sort.value }));
  } catch {
    // Storage can be unavailable; the view just won't be remembered.
  }
});

const currentGroup = computed(() => GROUPS.find((g) => g.key === group.value)!);
const inGroup = (g: (typeof GROUPS)[number], t: TaskSummary) => g.facets.some((f) => f.test(t));

const repos = computed(() => [...new Set(props.tasks.map((t) => t.repo ?? '?'))].sort());
// A remembered repo that no longer has tasks would hide everything.
watch(repos, (names) => {
  if (repo.value && names.length && !names.includes(repo.value)) repo.value = '';
});

function matchesQuery(t: TaskSummary, q: string): boolean {
  if (!q) return true;
  const id = q.replace(/^#/, '');
  if (/^\d+$/.test(id)) return String(t.id).startsWith(id) || t.title.toLowerCase().includes(q);
  return [t.title, t.repo, t.branch, t.model, t.blocked_reason].some((s) => s?.toLowerCase().includes(q));
}

/** Tasks that pass the repo and search filters, before the group and facets. */
const base = computed(() => {
  const q = query.value.trim().toLowerCase();
  return props.tasks.filter((t) => (!repo.value || (t.repo ?? '?') === repo.value) && matchesQuery(t, q));
});

const groupCounts = computed(() => Object.fromEntries(GROUPS.map((g) => [g.key, base.value.filter((t) => inGroup(g, t)).length])));

const facetCounts = computed(() =>
  Object.fromEntries(currentGroup.value.facets.map((f) => [f.key, base.value.filter((t) => f.test(t)).length])),
);

/** Facets worth showing: those with tasks, plus any already picked. */
const visibleFacets = computed(() => currentGroup.value.facets.filter((f) => facetCounts.value[f.key] || facets.value.includes(f.key)));

const shown = computed(() => {
  const g = currentGroup.value;
  const picked = g.facets.filter((f) => facets.value.includes(f.key));
  const compare = SORTS.find((s) => s.key === sort.value)!.compare;
  return base.value.filter((t) => (picked.length ? picked.some((f) => f.test(t)) : inGroup(g, t))).sort(compare);
});

const filtered = computed(() => !!(query.value.trim() || repo.value || facets.value.length));

function pickGroup(key: string) {
  if (group.value !== key) facets.value = [];
  group.value = key;
}

function toggleFacet(key: string) {
  facets.value = facets.value.includes(key) ? facets.value.filter((k) => k !== key) : [...facets.value, key];
}

function clearFilters() {
  query.value = '';
  repo.value = '';
  facets.value = [];
}

// "/" jumps to the search box, Escape leaves it.
function onKey(e: KeyboardEvent) {
  const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    search.value?.focus();
  } else if (e.key === 'Escape' && e.target === search.value) {
    query.value = '';
    search.value?.blur();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const label = (s: TaskStatus) => (s === 'cancel_requested' ? 'stopping' : s);
</script>

<template>
  <aside class="list">
    <nav class="filters">
      <button v-for="g in GROUPS" :key="g.key" :class="{ on: group === g.key }" @click="pickGroup(g.key)">
        {{ g.label }} <span class="n">{{ groupCounts[g.key] }}</span>
      </button>
    </nav>
    <div class="tools">
      <input ref="search" v-model="query" class="search" type="search" placeholder="Search title, #id, branch…  ( / )" />
      <div class="row">
        <select v-if="repos.length > 1 || repo" v-model="repo" aria-label="Repo">
          <option value="">All repos</option>
          <option v-for="r in repos" :key="r" :value="r">{{ r }}</option>
        </select>
        <select v-model="sort" aria-label="Sort">
          <option v-for="s in SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
      </div>
      <div v-if="visibleFacets.length > 1 || facets.length" class="facets">
        <button
          v-for="f in visibleFacets"
          :key="f.key"
          class="facet"
          :class="{ on: facets.includes(f.key) }"
          :aria-pressed="facets.includes(f.key)"
          @click="toggleFacet(f.key)"
        >
          {{ f.label }} <span class="n">{{ facetCounts[f.key] }}</span>
        </button>
      </div>
    </div>
    <div class="items">
      <p v-if="!shown.length" class="empty muted">
        <template v-if="filtered">Nothing matches. <button class="link" @click="clearFilters">Clear filters</button></template>
        <template v-else>Nothing here.</template>
      </p>
      <button
        v-for="t in shown"
        :key="t.id"
        class="item"
        :class="[`s-${t.status}`, { sel: t.id === selected }]"
        @click="$emit('select', t.id)"
      >
        <span class="dot" />
        <span class="main">
          <span class="title">{{ t.title }}</span>
          <span class="meta muted">
            #{{ t.id }} · {{ t.repo }} · {{ label(t.status) }}<template v-if="t.source === 'planner'"> · planner</template
            ><template v-if="t.waiting && !t.waiting.stuck"> · waiting on #{{ t.waiting.on }}</template
            ><template v-if="t.pr_url"> · PR {{ t.pr_state ?? 'open' }}</template
            ><template v-if="t.attempts > 1"> · try {{ t.attempts }}</template> · p{{ t.priority }} ·
            {{ ago(sort === 'newest' || sort === 'oldest' ? t.created_at : t.updated_at) }}
          </span>
          <span v-if="t.blocked_reason && (t.status === 'blocked' || t.status === 'failed')" class="reason">{{ t.blocked_reason }}</span>
          <span v-if="t.waiting?.stuck" class="reason"
            >Can't start: {{ t.waiting.stuck }}. Retry #{{ t.waiting.on }} or cancel this task.</span
          >
        </span>
      </button>
    </div>
    <footer v-if="filtered" class="foot muted">
      {{ shown.length }} of {{ tasks.length }} · <button class="link" @click="clearFilters">clear filters</button>
    </footer>
  </aside>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}
.filters {
  display: flex;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.filters button {
  border: none;
  background: none;
  padding: 3px 8px;
  color: var(--muted);
}
.filters button.on {
  background: var(--panel-2);
  color: var(--text);
}
.tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.search {
  padding: 4px 8px;
}
.row {
  display: flex;
  gap: 6px;
}
.row select {
  padding: 3px 6px;
  min-width: 0;
}
.facets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.facet {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--muted);
  background: none;
}
.facet.on {
  color: var(--text);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  text-decoration: underline;
}
.foot {
  padding: 6px 14px;
  font-size: 12px;
  border-top: 1px solid var(--border);
}
.n {
  font-size: 11px;
  opacity: 0.7;
  margin-left: 2px;
}
.items {
  overflow-y: auto;
  flex: 1;
}
.empty {
  padding: 16px;
}
.item {
  display: flex;
  gap: 10px;
  align-items: baseline;
  width: 100%;
  text-align: left;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: none;
  padding: 10px 14px;
}
.item:hover {
  background: var(--panel-2);
}
.item.sel {
  background: color-mix(in srgb, var(--accent) 10%, var(--panel));
  box-shadow: inset 3px 0 0 var(--accent);
}
.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.title {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
}
.reason {
  font-size: 12px;
  color: var(--c);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
