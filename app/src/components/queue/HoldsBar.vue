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
  <div v-if="hold || repos.length" class="holds" role="status">
    <div v-if="hold" class="hold s-blocked">
      <span class="what"
        ><strong>{{ queued }} queued {{ queued === 1 ? 'task' : 'tasks' }} can't start.</strong> {{ describeHold(hold) }}.</span
      >
      <button v-if="hold.kind === 'daemon-paused'" class="primary" :disabled="busy" @click="emit('resume')">▶ Resume</button>
      <button v-else-if="hold.kind === 'governor'" @click="emit('settings')">Usage settings</button>
    </div>
    <div v-for="r in repos" :key="r.id" class="hold s-blocked">
      <span class="what" :title="r.reason">
        <strong>{{ r.name }} is paused</strong>
        <span class="muted"> · {{ r.queued }} queued</span>
        <span class="reason">{{ r.reason.split('\n')[0] }}</span>
      </span>
      <button class="primary" :disabled="busy" title="Let this repo's tasks run again" @click="emit('resumeRepo', r.id)">
        ▶ Resume {{ r.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.holds {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 24px 0;
}
.hold {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
  background: color-mix(in srgb, var(--c) 9%, var(--panel));
}
.what {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reason {
  margin-left: 8px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
button {
  flex-shrink: 0;
}
</style>
