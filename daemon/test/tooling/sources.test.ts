// The shared source parser (scripts/lib/sources.ts), on a .vue file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSource, vueScript } from '../../scripts/lib/sources.ts';

const VUE = `<template>
  <div>{{ x }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { Task } from '../api/types';
const x = ref(0);
</script>

<script lang="ts">
export { default as Thing } from './Thing.vue';
const lazy = () => import('./Lazy.vue');
</script>

<style>
.a { color: red; }
</style>
`;

test('a .vue file keeps its script lines', () => {
  const lines = VUE.split('\n');
  const code = vueScript(VUE).split('\n');
  assert.equal(code.length, lines.length);
  assert.equal(code[5], lines[5]);
  assert.equal(code[1].trim(), '');
});

test('the parser lists the imports of a .vue file with their lines', () => {
  const { imports } = parseSource('components/Thing.vue', VUE);
  assert.deepEqual(
    imports.map((i) => [i.spec, i.line, i.typeOnly, i.target]),
    [
      ['vue', 6, false, null],
      ['../api/types', 7, true, 'api/types'],
      ['./Thing.vue', 12, false, 'components/Thing.vue'],
      ['./Lazy.vue', 13, false, 'components/Lazy.vue'],
    ],
  );
});
