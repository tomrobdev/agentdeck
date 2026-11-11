// pnpm imports:fix: rewrites every relative import in the daemon and the app to its # subpath import.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixImports, scannedFiles } from '#scripts/lib/absolute-imports.ts';
import { REPO } from '#scripts/lib/imports.ts';

let changed = 0;
const unfixed: string[] = [];
for (const file of scannedFiles()) {
  const path = join(REPO, file);
  const text = readFileSync(path, 'utf8');
  const fixed = fixImports(file, text);
  unfixed.push(...fixed.unfixed.map((r) => `${file}:${r.line} imports ${r.spec}: no # prefix names its folder`));
  if (fixed.text === text) continue;
  writeFileSync(path, fixed.text);
  changed++;
}
console.log(`rewrote the relative imports of ${changed} file${changed === 1 ? '' : 's'}`);
if (unfixed.length) {
  console.error(unfixed.join('\n'));
  process.exitCode = 1;
}
