<script setup lang="ts">
defineProps<{ shown: number; total: number }>();
</script>

<template>
  <footer class="text-muted flex justify-between gap-3 border-t border-border px-4 py-[5px] text-sm">
    <span
      >{{ shown }}<template v-if="shown !== total"> of {{ total }}</template> tasks</span
    >
    <span class="max-sm:hidden"
      ><kbd>j</kbd><kbd>k</kbd> move · <kbd>␣</kbd> peek · <kbd>↵</kbd> open · <kbd>a</kbd> approve · <kbd>r</kbd> retry ·
      <kbd>m</kbd> merge ·<kbd>v</kbd> list/board/graph · <kbd>x</kbd> select · <kbd>c</kbd> new · <kbd>/</kbd> search ·
      <kbd>⌘K</kbd> commands</span
    >
  </footer>
</template>
