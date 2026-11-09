<script setup lang="ts">
// The selected task beside the list, behind a separator that resizes it. Its width is remembered.
import { ref } from 'vue';
import { useResize } from '../../../composables/shared/useResize';
import { loadSetting, saveSetting } from '../../../lib/shared/storage';
import type { PersonEvent } from '../../../../../daemon/src/domain/work/index.ts';
import TaskPeek from './TaskPeek.vue';

defineProps<{ id: number }>();
const emit = defineEmits<{ open: []; close: []; act: [kind: PersonEvent, id: number]; merge: [id: number]; peek: [id: number] }>();

const PEEK_MIN = 320;
const peekWidth = ref(Math.max(PEEK_MIN, loadSetting<number>('peekWidth', 520)));
const { startResize } = useResize(peekWidth, {
  min: PEEK_MIN,
  max: () => window.innerWidth - 320,
  onEnd: (w) => saveSetting('peekWidth', w),
});
</script>

<template>
  <div
    class="w-1 flex-none cursor-col-resize bg-border hover:bg-accent"
    role="separator"
    aria-orientation="vertical"
    title="Drag to resize"
    @pointerdown="startResize"
  />
  <div class="flex min-h-0 flex-none flex-col border-l border-border" :style="{ width: `${peekWidth}px` }">
    <TaskPeek
      :id="id"
      @open="emit('open')"
      @close="emit('close')"
      @act="(kind, taskId) => emit('act', kind, taskId)"
      @merge="emit('merge', $event)"
      @peek="emit('peek', $event)"
    />
  </div>
</template>
