// pnpm docs:gen: rewrites the generated block of docs/architecture.md and the files of docs/reference/ from the code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_PATH, REFERENCE_DIR, generateReference, readDocs, renderDocs } from './lib/architecture-docs.ts';

const changed: string[] = [];

const before = readDocs();
const after = renderDocs(before);
if (after !== before) {
  writeFileSync(DOCS_PATH, after);
  changed.push('docs/architecture.md');
}

mkdirSync(REFERENCE_DIR, { recursive: true });
for (const [name, content] of Object.entries(generateReference())) {
  const path = join(REFERENCE_DIR, name);
  if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
  writeFileSync(path, content);
  changed.push(`docs/reference/${name}`);
}

console.log(changed.length ? `docs: rewrote ${changed.join(', ')}` : 'docs: up to date');
