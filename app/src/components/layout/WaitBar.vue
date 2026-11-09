<script setup lang="ts">
import { computed } from 'vue';
import { describeWait } from '../../lib/work/work-wording';
import type { Status } from '../../api/types';
import { oneLine, plural } from '../../../../daemon/src/domain/shared/index.ts';
import { openPanel } from '../../composables/shared/useShell';

// What queued tasks wait for, each with the action that ends the wait. Empty when nothing keeps work waiting.
const props = defineProps<{ status: Status | null; busy: boolean }>();
const emit = defineEmits<{ resume: []; resumeRepo: [id: number] }>();

const queued = computed(() => props.status?.counts.queued ?? 0);
const wait = computed(() => (queued.value ? (props.status?.wait ?? null) : null));
const repos = computed(() => props.status?.paused_repos ?? []);
</script>

<template>
  <div v-if="wait || repos.length" class="mx-6 mt-3 flex flex-col gap-1.5" role="status">
    <div
      v-if="wait"
      class="s-blocked flex items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--c)_40%,transparent)] bg-[color-mix(in_srgb,var(--c)_9%,var(--panel))] px-3 py-2"
    >
      <span class="min-w-0 flex-1 truncate"
        ><strong>{{ plural(queued, 'queued task') }} can't start.</strong> {{ describeWait(wait) }}.</span
      >
      <button v-if="wait.kind === 'daemon-paused'" class="primary shrink-0" :disabled="busy" @click="emit('resume')">▶ Resume</button>
      <button v-else-if="wait.kind === 'governor'" class="shrink-0" @click="openPanel('settings')">Usage settings</button>
    </div>
    <div
      v-for="r in repos"
      :key="r.id"
      class="s-blocked flex items-center gap-3 rounded-md border border-[color-mix(in_srgb,var(--c)_40%,transparent)] bg-[color-mix(in_srgb,var(--c)_9%,var(--panel))] px-3 py-2"
    >
      <span class="min-w-0 flex-1 truncate" :title="r.reason">
        <strong>{{ r.name }} is paused</strong>
        <span class="text-muted"> · {{ r.queued }} queued</span>
        <span class="ml-2 font-mono text-sm">{{ oneLine(r.reason) }}</span>
      </span>
      <button class="primary shrink-0" :disabled="busy" title="Let this repo's tasks run again" @click="emit('resumeRepo', r.id)">
        ▶ Resume {{ r.name }}
      </button>
    </div>
  </div>
</template>
