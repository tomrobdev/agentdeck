<script setup lang="ts">
import { computed } from 'vue';
import type { TaskSummary } from '../../api';
import { openTask } from '../../router';
import { TONE_CHIP, taskBadges } from '../../lib/taskBadges';

// A task's attention chips, links and facts, the same in every view (rules in lib/taskBadges.ts). A link opens its task.
// `nowrap` keeps them on one line, the facts truncated, for a list row.
const props = defineProps<{ task: TaskSummary; repo?: boolean; pr?: boolean; nowrap?: boolean }>();
const b = computed(() => taskBadges(props.task, { repo: props.repo, pr: props.pr }));
const tags = (ids: number[]) => ids.map((id) => `#${id}`).join(' ');
</script>

<template>
  <span
    v-if="b.attention.length || b.up.length || b.down.length || b.facts.length"
    class="inline-flex min-w-0 items-center gap-x-2 gap-y-1 text-sm"
    :class="nowrap ? 'flex-nowrap' : 'flex-wrap'"
  >
    <span v-for="a in b.attention" :key="a.label" class="chip" :class="TONE_CHIP[a.tone]" :title="a.title">{{ a.label }}</span>
    <span
      v-if="b.up.length"
      class="inline-flex gap-1 font-mono whitespace-nowrap text-muted"
      :title="`Builds on ${tags(b.up)}: starts once they are done and merged`"
      data-links-up
    >
      ↑<a v-for="id in b.up" :key="id" class="cursor-pointer hover:text-text" @click.stop="openTask(id)">#{{ id }}</a>
    </span>
    <span
      v-if="b.down.length"
      class="inline-flex gap-1 font-mono whitespace-nowrap text-accent"
      :title="`Merging this releases ${tags(b.down)}`"
      data-links-down
    >
      ↓<a v-for="id in b.down" :key="id" class="cursor-pointer hover:underline" @click.stop="openTask(id)">#{{ id }}</a>
    </span>
    <span v-if="b.facts.length" class="min-w-0 truncate text-muted">
      <template v-for="(f, i) in b.facts" :key="f.label"
        ><template v-if="i"> · </template><span :title="f.title">{{ f.label }}</span></template
      >
    </span>
  </span>
</template>
