<script setup lang="ts">
import { keyCaps, registeredKeys, sheetGroups } from '#lib/shared/hotkeys.ts';
import Modal from '#components/ui/Modal.vue';

const emit = defineEmits<{ close: [] }>();
const groups = sheetGroups(registeredKeys());
</script>

<template>
  <Modal title="Keyboard shortcuts" @close="emit('close')">
    <section v-for="g in groups" :key="g.scope" class="mb-3" :data-scope="g.scope">
      <h3 class="mt-0 mb-1 text-sm text-muted">{{ g.label }}</h3>
      <ul class="m-0 list-none p-0">
        <li v-for="k in g.keys" :key="k.key" class="flex items-center gap-2 py-0.5" data-hotkey>
          <span class="flex-1">{{ k.label }}</span>
          <span class="flex gap-1">
            <template v-for="(cap, i) in keyCaps(k.key)" :key="i">
              <span v-if="i" class="text-sm text-muted">then</span>
              <kbd class="rounded-sm border border-border bg-panel-2 px-1.5 text-sm">{{ cap }}</kbd>
            </template>
          </span>
        </li>
      </ul>
    </section>
    <p class="mt-0 mb-0 text-sm text-muted">⌘K opens the command palette, which lists these commands too.</p>
  </Modal>
</template>
