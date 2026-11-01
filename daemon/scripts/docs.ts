// pnpm run docs: rewrites the generated blocks of docs/architecture.md from the code.
import { writeFileSync } from 'node:fs';
import { DOCS_PATH, readDocs, renderDocs } from './lib/architecture-docs.ts';

const before = readDocs();
const after = renderDocs(before);
if (after === before) {
  console.log('docs: docs/architecture.md is up to date');
} else {
  writeFileSync(DOCS_PATH, after);
  console.log('docs: rewrote the generated blocks of docs/architecture.md');
}
