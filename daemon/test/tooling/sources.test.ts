// The shared source parser (scripts/lib/sources.ts), on a .vue file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSource, vueScript } from '#scripts/lib/sources.ts';

const VUE = `<template>
  <div>{{ x }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { Task } from '#api/types.ts';
const x = ref(0);
</script>

<script lang="ts">
export { default as Thing } from '#components/Thing.vue';
const lazy = () => import('#components/Lazy.vue');
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
      ['#api/types.ts', 7, true, 'api/types.ts'],
      ['#components/Thing.vue', 12, false, 'components/Thing.vue'],
      ['#components/Lazy.vue', 13, false, 'components/Lazy.vue'],
    ],
  );
});

test('a # import resolves to its file, relative to the root it was read from', () => {
  const targets = (path: string, code: string, root?: string) => parseSource(path, code, root).imports.map((i) => i.target);
  const dashboard = "import { a } from '#daemon/domain/work/index.ts';\nimport type { B } from '#daemon/api/contract/work.ts';\n";
  assert.deepEqual(targets('lib/x.ts', dashboard, 'app/src'), [
    '../../daemon/src/domain/work/index.ts',
    '../../daemon/src/api/contract/work.ts',
  ]);
  assert.deepEqual(targets('lib/x.ts', "import { a } from '#daemon/db/index.ts';\n", 'app/src'), [null]);
  assert.deepEqual(
    targets('cli/x.ts', "import { a } from '#src/compose.ts';\nimport { b } from '#test/fixtures/fixtures.ts';\n", 'daemon/src'),
    ['compose.ts', '../test/fixtures/fixtures.ts'],
  );
  assert.deepEqual(
    targets('x.test.ts', "import { a } from '#app/lib/shared/tone.ts';\nimport type { T } from '#type-only';\n", 'daemon/test'),
    ['../../app/src/lib/shared/tone.ts', null],
  );
  assert.deepEqual(targets('a.ts', "type T = import('#domain/work/index.ts').Task;\n"), ['domain/work/index.ts']);
});
