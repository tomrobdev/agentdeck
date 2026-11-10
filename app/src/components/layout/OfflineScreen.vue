<script setup lang="ts">
import { ref } from 'vue';
import { errorMessage } from '../../../../daemon/src/domain/shared/index.ts';
import { isNative, startDaemon } from '../../platform/native';

const emit = defineEmits<{ started: [] }>();

const starting = ref(false);
const startError = ref('');
async function start() {
  starting.value = true;
  startError.value = '';
  try {
    await startDaemon();
    emit('started');
  } catch (e) {
    startError.value = errorMessage(e);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="m-auto max-w-[420px] text-center">
    <h2 class="text-lg">The AgentDeck daemon isn't running</h2>
    <template v-if="isNative">
      <p class="text-muted">Start it here and this window will connect on its own.</p>
      <button class="primary" :disabled="starting" @click="start">{{ starting ? 'Starting…' : 'Start the daemon' }}</button>
      <p v-if="startError" class="mt-2 text-sm" role="alert">{{ startError }}</p>
    </template>
    <template v-else>
      <p class="text-muted">Start it in a terminal and this window will connect on its own:</p>
      <pre class="rounded-md border border-border bg-code-bg p-2.5">agentdeck service start</pre>
    </template>
  </div>
</template>
