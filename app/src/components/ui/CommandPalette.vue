<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxRoot,
  ComboboxViewport,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { type PaletteItem, searchPalette } from '../../lib/work/palette';

const props = defineProps<{ items: PaletteItem[] }>();
const emit = defineEmits<{ close: [] }>();

const query = ref('');
const combobox = ref<{ highlightFirstItem: () => void } | null>(null);
const input = ref<{ $el: HTMLInputElement } | null>(null);
const chosen = ref(false);

const MAX_ROWS = 50;
const shown = computed(() => searchPalette(props.items, query.value).slice(0, MAX_ROWS));
watch(query, async () => {
  await nextTick();
  combobox.value?.highlightFirstItem();
});

function choose(item: PaletteItem) {
  chosen.value = true;
  emit('close');
  item.run();
}

function onKey(e: KeyboardEvent) {
  const key = e.ctrlKey && e.key === 'n' ? 'ArrowDown' : e.ctrlKey && e.key === 'p' ? 'ArrowUp' : null;
  if (!key) return;
  e.preventDefault();
  input.value?.$el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const keepFocus = (e: Event) => chosen.value && e.preventDefault();
</script>

<template>
  <DialogRoot :open="true" @update:open="(open) => !open && emit('close')">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-20 bg-[rgb(0_0_0/0.35)]" />
      <DialogContent
        class="fixed top-[15vh] left-1/2 z-20 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-panel shadow-modal"
        :aria-describedby="undefined"
        @open-auto-focus.prevent="input?.$el.focus()"
        @close-auto-focus="keepFocus"
      >
        <DialogTitle class="sr-only">Command palette</DialogTitle>
        <ComboboxRoot ref="combobox" :open="true" ignore-filter :reset-search-term-on-select="false">
          <ComboboxInput
            ref="input"
            v-model="query"
            class="w-full border-0 border-b border-border bg-transparent px-4 py-3 outline-none"
            placeholder="Jump to #id or title, or run a command"
            aria-label="Command"
            autocomplete="off"
            spellcheck="false"
            @keydown="onKey"
          />
          <ComboboxContent @escape-key-down.prevent="emit('close')">
            <ComboboxViewport class="max-h-[50vh] overflow-auto p-1">
              <ComboboxItem
                v-for="item in shown"
                :key="item.key"
                :value="item.key"
                class="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 outline-none data-[highlighted]:bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] data-[highlighted]:shadow-[inset_2px_0_0_var(--accent)]"
                @select.prevent="choose(item)"
              >
                <span class="flex-none">{{ item.label }}</span>
                <span v-if="item.detail" class="text-muted min-w-0 flex-1 truncate">{{ item.detail }}</span>
                <span v-else class="flex-1" />
                <kbd v-if="item.shortcut" class="flex-none">{{ item.shortcut }}</kbd>
              </ComboboxItem>
              <ComboboxEmpty class="text-muted px-3 py-3">Nothing matches “{{ query }}”.</ComboboxEmpty>
            </ComboboxViewport>
          </ComboboxContent>
          <footer class="text-muted flex gap-3 border-t border-border px-4 py-1.5 text-sm">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> run</span>
            <span><kbd>esc</kbd> close</span>
          </footer>
        </ComboboxRoot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
