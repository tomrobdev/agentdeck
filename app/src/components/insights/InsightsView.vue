<script setup lang="ts">
// The pilot scorecard over time: this week's number for each measure against its target, with the weekly trend
// beneath. The numbers are `agentdeck stats --by week --json`, for all repos or the one chosen.
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { reposQuery, statsQuery } from '../../api';
import { seriesOf, thisWeek, weekLabel } from '../../lib/insights';
import TrendChart from './TrendChart.vue';

const repo = ref<string | null>(null);
const reposQ = useQuery(reposQuery());
const statsQ = useQuery(computed(() => statsQuery(repo.value)));

const cards = computed(() => (statsQ.data.value ? seriesOf(statsQ.data.value) : []));
const week = thisWeek();
const nowOf = (s: (typeof cards.value)[number]) => s.points.find((p) => p.week === week) ?? null;
const empty = computed(() => cards.value.length === 0);
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
      <article v-for="s in cards" :key="s.measure.key" class="rounded-md border border-border bg-panel p-3">
        <header class="flex items-baseline justify-between gap-2">
          <h2 class="m-0 text-md">{{ s.measure.label }}</h2>
          <span v-if="s.met !== null" class="verdict" :class="s.met ? 'met' : 'missed'">{{ s.met ? 'On target' : 'Off target' }}</span>
        </header>
        <p class="m-0 mt-1 text-xl font-[650]">
          {{ nowOf(s)?.value == null ? '–' : s.measure.format(nowOf(s)!.value!) }}
          <small v-if="nowOf(s)?.detail" class="text-muted text-sm font-normal">{{ nowOf(s)!.detail }}</small>
        </p>
        <p class="text-muted m-0 mb-2 text-sm">
          {{ s.measure.hint }}<template v-if="s.measure.target"> · target {{ s.measure.target.text }}</template
          ><template v-if="s.total !== null"> · {{ s.measure.format(s.total) }} in all weeks</template>
        </p>
        <TrendChart :series="s" />
      </article>
    </div>
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
