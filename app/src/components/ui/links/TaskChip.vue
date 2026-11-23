<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import { tasksQuery } from '#api/work.ts';
import { statusText } from '#lib/work/task-badges.ts';
import { useCopy } from '#platform/native.ts';
import Chip from '#components/ui/Chip.vue';
import StatusIcon from '#components/ui/status/StatusIcon.vue';

const props = withDefaults(defineProps<{ id: number; kind?: 'link' | 'label' | 'self' }>(), { kind: 'link' });
const tasksQ = useQuery(computed(() => ({ ...tasksQuery(), enabled: props.kind !== 'self', refetchOnMount: false })));
const task = computed(() => tasksQ.data.value?.find((t) => t.id === props.id));
const tip = computed(() => (task.value ? `${task.value.title} (${statusText(task.value)})` : `Task #${props.id}`));
const { copied, copy } = useCopy();
</script>

<template>
  <Chip
    v-if="kind === 'self'"
    as="button"
    class="flex-none font-mono hover:text-accent"
    :title="`Copy #${id}`"
    data-task-chip="self"
    @click="copy(`#${id}`, 'id')"
    >{{ copied ? 'Copied' : `#${id}` }}</Chip
  >
  <RouterLink v-else-if="kind === 'link'" v-slot="{ href, navigate }" custom :to="{ name: 'task', params: { id } }">
    <Chip
      as="a"
      class="flex-none font-mono no-underline hover:text-accent"
      :href="href"
      :title="tip"
      data-task-chip="link"
      @click.stop="navigate"
    >
      <StatusIcon v-if="task" :task="task" :size="12" />#{{ id }}
    </Chip>
  </RouterLink>
  <Chip v-else class="flex-none font-mono" :title="tip" data-task-chip="label">
    <StatusIcon v-if="task" :task="task" :size="12" />#{{ id }}
  </Chip>
</template>
