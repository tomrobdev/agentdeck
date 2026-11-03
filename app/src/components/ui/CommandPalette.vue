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
import { type PaletteItem, searchPalette } from '../../lib/palette';

// ⌘K: jump to a task or run a command from the keyboard. App builds the rows (lib/palette.ts); this lists and runs them.
// The order is searchPalette's fuzzy ranking, so the Combobox does no filtering of its own (ignore-filter) and the first row is
// highlighted again whenever the term changes.
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

// Ctrl-N and Ctrl-P move like the arrow keys: hand the combobox the key it already understands.
function onKey(e: KeyboardEvent) {
  const key = e.ctrlKey && e.key === 'n' ? 'ArrowDown' : e.ctrlKey && e.key === 'p' ? 'ArrowUp' : null;
  if (!key) return;
  e.preventDefault();
  input.value?.$el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// What a row opened (a dialog, say) owns the focus now: don't hand it back to whatever the palette was opened from.
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
          <!-- The content is the topmost layer, so it gets the Escape: it closes the palette, not just the list. -->
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
