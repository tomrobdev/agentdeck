<script setup lang="ts">
import { computed } from 'vue';
import { promptBrief } from '#daemon/domain/work/index.ts';
import Markdown from '#components/ui/Markdown.vue';

const props = defineProps<{ prompt: string; isPath?: (p: string) => boolean }>();
const emit = defineEmits<{ path: [path: string, line: number | null] }>();

const brief = computed(() => promptBrief(props.prompt));
const OUTCOME = 'Expected outcome';
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" data-task-brief>
    <section v-for="s in brief.sections" :key="s.name" :data-brief-section="s.name">
      <h3 class="m-0 mb-1 text-sm font-semibold text-muted">{{ s.name }}</h3>
      <Markdown :class="s.name === OUTCOME && 'brief-outcome'" :text="s.body" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
    </section>
    <Markdown v-if="brief.rest" :text="brief.rest" :is-path="isPath" @path="(p, l) => emit('path', p, l)" />
  </div>
</template>

<style>
@layer components {
  .brief-outcome ul {
    list-style: none;
    padding-left: 0.2em;
  }
  .brief-outcome ul > li {
    position: relative;
    padding-left: 1.5em;
  }
  .brief-outcome ul > li > p {
    margin: 0;
  }
  .brief-outcome ul > li::before {
    content: '☐';
    position: absolute;
    left: 0;
    color: var(--muted);
  }
}
</style>
