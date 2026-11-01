<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { type PaletteItem, searchPalette } from '../../lib/palette';

// ⌘K: jump to a task or run a command from the keyboard. App builds the rows (lib/palette.ts); this lists, filters and runs them.
const props = defineProps<{ items: PaletteItem[] }>();
const emit = defineEmits<{ close: [] }>();

const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

const MAX_ROWS = 50;
const shown = computed(() => searchPalette(props.items, query.value).slice(0, MAX_ROWS));
watch(query, () => (active.value = 0));

onMounted(() => input.value?.focus());

function move(by: number) {
  if (!shown.value.length) return;
  active.value = (active.value + by + shown.value.length) % shown.value.length;
  nextTick(() => list.value?.children[active.value]?.scrollIntoView({ block: 'nearest' }));
}

function choose(item: PaletteItem | undefined) {
  if (!item) return;
  emit('close');
  item.run();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1);
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(-1);
  else if (e.key === 'Enter') choose(shown.value[active.value]);
  else if (e.key === 'Escape') emit('close');
  else return;
  e.preventDefault();
}
</script>

<template>
  <div class="fixed inset-0 z-20 grid place-items-start justify-center bg-[rgb(0_0_0/0.35)] pt-[15vh]" @click.self="emit('close')">
    <div
      class="w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-lg border border-border bg-panel shadow-modal"
      role="dialog"
      aria-label="Command palette"
      @keydown="onKey"
    >
      <input
        ref="input"
        v-model="query"
        class="w-full border-0 border-b border-border bg-transparent px-4 py-3 outline-none"
        placeholder="Jump to #id or title, or run a command"
        aria-label="Command"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        :aria-activedescendant="shown.length ? `palette-row-${active}` : undefined"
        autocomplete="off"
        spellcheck="false"
      />
      <ul id="palette-list" ref="list" class="m-0 max-h-[50vh] list-none overflow-auto p-1" role="listbox">
        <li
          v-for="(item, i) in shown"
          :id="`palette-row-${i}`"
          :key="item.key"
          class="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5"
          :class="{ 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] shadow-[inset_2px_0_0_var(--accent)]': i === active }"
          role="option"
          :aria-selected="i === active"
          @mousemove="active = i"
          @click="choose(item)"
        >
          <span class="flex-none">{{ item.label }}</span>
          <span v-if="item.detail" class="muted min-w-0 flex-1 truncate">{{ item.detail }}</span>
          <span v-else class="flex-1" />
          <kbd v-if="item.shortcut" class="flex-none">{{ item.shortcut }}</kbd>
        </li>
        <li v-if="!shown.length" class="muted px-3 py-3">Nothing matches “{{ query }}”.</li>
      </ul>
      <footer class="muted flex gap-3 border-t border-border px-4 py-1.5 text-sm">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> run</span>
        <span><kbd>esc</kbd> close</span>
      </footer>
    </div>
  </div>
</template>
