<script setup lang="ts">
import { computed } from 'vue';
import { type Series, weekLabel } from '#lib/insights/insights.ts';

const props = defineProps<{ series: Series }>();

const W = 240;
const H = 56;
const PAD = 6;

const values = computed(() => props.series.points.flatMap((p) => (p.value === null ? [] : [p.value])));
const top = computed(() => {
  const t = props.series.measure.target?.value ?? 0;
  return Math.max(props.series.measure.floor ?? 0, t, ...values.value) || 1;
});

const x = (i: number) => (props.series.points.length < 2 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (props.series.points.length - 1));
const y = (v: number) => H - PAD - (v / top.value) * (H - 2 * PAD);

const runs = computed(() => {
  const out: { x: number; y: number }[][] = [];
  props.series.points.forEach((p, i) => {
    if (p.value === null) return void out.push([]);
    if (!out.length) out.push([]);
    out[out.length - 1].push({ x: x(i), y: y(p.value) });
  });
  return out.filter((r) => r.length > 1);
});

const dots = computed(() =>
  props.series.points.flatMap((p, i) =>
    p.value === null ? [] : [{ cx: x(i), cy: y(p.value), title: `${weekLabel(p.week)}: ${props.series.measure.format(p.value)}` }],
  ),
);
const targetY = computed(() => (props.series.measure.target ? y(props.series.measure.target.value) : null));
const first = computed(() => props.series.points[0]?.week);
const last = computed(() => props.series.points[props.series.points.length - 1]?.week);
</script>

<template>
  <figure class="m-0">
    <svg :viewBox="`0 0 ${W} ${H}`" class="block h-14 w-full" role="img" :aria-label="`${series.measure.label} per week`">
      <line v-if="targetY !== null" :x1="PAD" :x2="W - PAD" :y1="targetY" :y2="targetY" class="target" />
      <polyline v-for="(r, i) in runs" :key="i" :points="r.map((p) => `${p.x},${p.y}`).join(' ')" class="line" />
      <circle v-for="d in dots" :key="d.cx" :cx="d.cx" :cy="d.cy" r="3" class="dot">
        <title>{{ d.title }}</title>
      </circle>
    </svg>
    <figcaption class="text-muted flex justify-between text-2xs">
      <span>{{ first ? weekLabel(first) : '' }}</span>
      <span>{{ last ? weekLabel(last) : '' }}</span>
    </figcaption>
    <ul class="sr-only">
      <li v-for="p in series.points" :key="p.week">
        {{ weekLabel(p.week) }}: {{ p.value === null ? 'no data' : series.measure.format(p.value) }}
      </li>
    </ul>
  </figure>
</template>

<style scoped>
.line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-linejoin: round;
}
.dot {
  fill: var(--accent);
}
.target {
  stroke: var(--muted);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
</style>
