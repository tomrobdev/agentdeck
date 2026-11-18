// rule:absolute-imports: every import in the daemon and the app uses the # prefix of its layer, never ./ or ../.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fixImports, relativeImports, scannedFiles } from '#scripts/lib/absolute-imports.ts';
import { REPO, aliasesOf } from '#scripts/lib/imports.ts';

const quoted = (spec: string) => `'${spec}'`;

function violations(file: string, text: string): string[] {
  return relativeImports(file, text).map((r) => `${file}:${r.line} imports ${r.spec}: use its # prefix (run pnpm imports:fix)`);
}

test('[absolute-imports] no file in daemon/src, daemon/test, daemon/scripts, app/src or app/e2e imports with a relative path', () => {
  const files = scannedFiles();
  assert.ok(files.length > 500, 'the scan finds the sources');
  assert.deepEqual(
    files.flatMap((f) => violations(f, readFileSync(join(REPO, f), 'utf8'))),
    [],
  );
});

test('[absolute-imports] a relative import fails with its file and line, and imports:fix rewrites it to its # form', () => {
  const file = 'daemon/src/domain/work/sample.ts';
  const text = [
    "import { test } from 'node:test';",
    `import { a } from ${quoted('./task/task.ts')};`,
    `export { b } from ${quoted('../shared/text.ts')};`,
    `const c = () => import(${quoted('../../db/index.ts')});`,
    `type D = import(${quoted('../runs/index.ts')}).Run;`,
    '',
  ].join('\n');
  assert.deepEqual(violations(file, text), [
    `${file}:2 imports ./task/task.ts: use its # prefix (run pnpm imports:fix)`,
    `${file}:3 imports ../shared/text.ts: use its # prefix (run pnpm imports:fix)`,
    `${file}:4 imports ../../db/index.ts: use its # prefix (run pnpm imports:fix)`,
    `${file}:5 imports ../runs/index.ts: use its # prefix (run pnpm imports:fix)`,
  ]);
  const fixed = fixImports(file, text);
  assert.deepEqual(fixed.unfixed, []);
  assert.equal(
    fixed.text,
    [
      "import { test } from 'node:test';",
      "import { a } from '#domain/work/task/task.ts';",
      "export { b } from '#domain/shared/text.ts';",
      "const c = () => import('#db/index.ts');",
      "type D = import('#domain/runs/index.ts').Run;",
      '',
    ].join('\n'),
  );
  assert.deepEqual(violations(file, fixed.text), []);
});

test('[absolute-imports] imports:fix names the file an extensionless import reaches, and reaches the daemon from the app by #daemon/', () => {
  const vue = `<template><div /></template>\n<script setup lang="ts">\nimport { tone } from ${quoted('../../lib/shared/tone')};\nimport { MODELS } from ${quoted('../../../../daemon/src/domain/work/index.ts')};\n</script>\n`;
  assert.equal(
    fixImports('app/src/components/ui/Sample.vue', vue).text,
    "<template><div /></template>\n<script setup lang=\"ts\">\nimport { tone } from '#lib/shared/tone.ts';\nimport { MODELS } from '#daemon/domain/work/index.ts';\n</script>\n",
  );
  const db = fixImports('app/src/lib/shared/sample.ts', `import { openDb } from ${quoted('../../../../daemon/src/db/index.ts')};\n`);
  assert.deepEqual(
    db.unfixed.map((r) => r.spec),
    ['../../../../daemon/src/db/index.ts'],
    'the daemon exports only its domain/ and api/contract/ to the app',
  );
});

test('[absolute-imports, dashboard-layout] Node resolves the app’s #daemon/ only to the daemon’s domain/ and api/contract/', () => {
  const app = createRequire(join(REPO, 'app/src/main.ts'));
  const resolved = (spec: string) => relative(REPO, app.resolve(spec)).split(sep).join('/');
  assert.equal(resolved('#daemon/domain/shared/index.ts'), 'daemon/src/domain/shared/index.ts');
  assert.equal(resolved('#daemon/api/contract/work.ts'), 'daemon/src/api/contract/work.ts');
  assert.equal(resolved('#lib/shared/tone.ts'), 'app/src/lib/shared/tone.ts');
  assert.equal(resolved('#docs/plans/plan.css'), 'docs/plans/plan.css');
  for (const spec of ['#daemon/db/index.ts', '#daemon/application/actions.ts', 'agentdeck-daemon/src/db/index.ts'])
    assert.throws(() => app.resolve(spec), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, spec);
  const daemon = createRequire(join(REPO, 'daemon/test/x.test.ts'));
  assert.equal(relative(REPO, daemon.resolve('#app/lib/shared/tone.ts')).split(sep).join('/'), 'app/src/lib/shared/tone.ts');
  assert.throws(() => daemon.resolve('#app/components/ui/Chip.vue'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('[absolute-imports] the prefixes come from the package.json imports, through the exports of a workspace package', () => {
  const aliases = aliasesOf([
    { dir: 'daemon', name: 'agentdeck-daemon', imports: { '#domain/*': './src/domain/*' }, exports: { './domain/*': './src/domain/*' } },
    { dir: 'app', name: 'agentdeck-app', imports: { '#lib/*': './src/lib/*', '#daemon/*': 'agentdeck-daemon/*' }, exports: {} },
  ]);
  assert.deepEqual(aliases, [
    { pkg: 'daemon', prefix: '#domain/', dir: 'daemon/src/domain/' },
    { pkg: 'app', prefix: '#lib/', dir: 'app/src/lib/' },
    { pkg: 'app', prefix: '#daemon/domain/', dir: 'daemon/src/domain/' },
  ]);
});
