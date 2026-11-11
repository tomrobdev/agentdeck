<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { statsQuery } from '#api/insights.ts';
import { reposQuery } from '#api/repos.ts';
import { hasData, seriesOf, thisWeek, weekLabel } from '#lib/insights/insights.ts';
import TrendChart from '#components/insights/TrendChart.vue';

const repo = ref<string | null>(null);
const reposQ = useQuery(reposQuery());
const statsQ = useQuery(computed(() => statsQuery(repo.value)));

const week = thisWeek();
const cards = computed(() =>
  (statsQ.data.value ? seriesOf(statsQ.data.value) : []).map((s) => ({ series: s, now: s.points.find((p) => p.week === week) ?? null })),
);
const top = computed(() => statsQ.data.value?.failures?.top ?? []);
const whereLabel = { opened: 'CI when the PR opened', merged: 'CI when it merged', run: 'work run' } as const;
const empty = computed(() => !hasData(cards.value.map((c) => c.series)));
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-auto p-4">
    <div class="mb-4 flex items-center gap-3">
      <h1 class="m-0 text-xl">Insights</h1>
      <span class="text-muted">Week of {{ weekLabel(week) }} against the pilot's targets</span>
      <div class="spacer" />
      <label class="flex items-center gap-2"
        >Repo
        <select v-model="repo" aria-label="Repo">
          <option :value="null">All repos</option>
          <option v-for="r in reposQ.data.value ?? []" :key="r.id" :value="r.name">{{ r.name }}</option>
        </select>
      </label>
    </div>

    <p v-if="statsQ.error.value" class="text-muted">Couldn't load the numbers: {{ statsQ.error.value.message }}</p>
    <p v-else-if="statsQ.isPending.value" class="text-muted">Loading…</p>
    <p v-else-if="empty" class="text-muted">No runs yet{{ repo ? ` in ${repo}` : '' }}, so there is nothing to chart.</p>
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
      <article v-for="{ series: s, now } in cards" :key="s.measure.key" class="rounded-md border border-border bg-panel p-3">
        <header class="flex items-baseline justify-between gap-2">
          <h2 class="m-0 text-md">{{ s.measure.label }}</h2>
          <span v-if="s.met !== null" class="verdict" :class="s.met ? 'met' : 'missed'">{{ s.met ? 'On target' : 'Off target' }}</span>
        </header>
        <p class="m-0 mt-1 text-xl font-[650]">
          {{ now?.value == null ? '–' : s.measure.format(now.value) }}
          <small v-if="now?.detail" class="text-muted text-sm font-normal">{{ now.detail }}</small>
        </p>
        <p class="text-muted m-0 mb-2 text-sm">
          {{ s.measure.hint }}<template v-if="s.measure.target"> · target {{ s.measure.target.text }}</template
          ><template v-if="s.total !== null"> · {{ s.measure.format(s.total) }} in all weeks</template>
        </p>
        <TrendChart :series="s" />
      </article>
    </div>

    <article v-if="top.length" class="mt-4 rounded-md border border-border bg-panel p-3" aria-label="Top causes of failure">
      <h2 class="m-0 text-md">Top causes of failure</h2>
      <p class="text-muted m-0 mb-2 text-sm">Failing CI checks by step, and failed or blocked runs by how they ended, in all weeks</p>
      <ol class="m-0 list-none p-0">
        <li v-for="c in top" :key="`${c.where}/${c.cause}`" class="flex items-baseline gap-2 py-0.5">
          <span class="font-[650]">{{ c.count }}×</span>
          <span>{{ c.cause }}</span>
          <span class="text-muted text-sm">{{ whereLabel[c.where] }}</span>
        </li>
      </ol>
    </article>
  </section>
</template>

<style scoped>
.verdict {
  font-size: var(--text-xs);
  font-weight: 600;
}
.met {
  color: var(--done);
}
.missed {
  color: var(--failed);
}
</style>
