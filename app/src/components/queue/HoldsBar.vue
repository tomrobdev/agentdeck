<script setup lang="ts">
import { computed } from 'vue';
import { type Status, describeHold } from '../../api';

// What keeps queued tasks from starting, each with the action that clears it. Empty when nothing holds work back.
const props = defineProps<{ status: Status | null; busy: boolean }>();
const emit = defineEmits<{ resume: []; resumeRepo: [id: number]; settings: [] }>();

const queued = computed(() => props.status?.counts.queued ?? 0);
const hold = computed(() => (queued.value ? (props.status?.hold ?? null) : null));
const repos = computed(() => props.status?.paused_repos ?? []);
</script>

<template>
  <div v-if="hold || repos.length" class="mx-6 mt-3 flex flex-col gap-1.5" role="status">
    <div
      v-if="hold"
      class="s-blocked flex items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--c)_40%,transparent)] bg-[color-mix(in_srgb,var(--c)_9%,var(--panel))] px-3 py-2"
    >
      <span class="min-w-0 flex-1 truncate"
        ><strong>{{ queued }} queued {{ queued === 1 ? 'task' : 'tasks' }} can't start.</strong> {{ describeHold(hold) }}.</span
      >
      <button v-if="hold.kind === 'daemon-paused'" class="primary shrink-0" :disabled="busy" @click="emit('resume')">▶ Resume</button>
      <button v-else-if="hold.kind === 'governor'" class="shrink-0" @click="emit('settings')">Usage settings</button>
    </div>
    <div
      v-for="r in repos"
      :key="r.id"
      class="s-blocked flex items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--c)_40%,transparent)] bg-[color-mix(in_srgb,var(--c)_9%,var(--panel))] px-3 py-2"
    >
      <span class="min-w-0 flex-1 truncate" :title="r.reason">
        <strong>{{ r.name }} is paused</strong>
        <span class="muted"> · {{ r.queued }} queued</span>
        <span class="ml-2 font-mono text-sm">{{ r.reason.split('\n')[0] }}</span>
      </span>
      <button class="primary shrink-0" :disabled="busy" title="Let this repo's tasks run again" @click="emit('resumeRepo', r.id)">
        ▶ Resume {{ r.name }}
      </button>
    </div>
  </div>
</template>
