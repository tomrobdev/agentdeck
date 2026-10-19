// Reads what toolchain detection looks at in a repo's root directory.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The names in a repo's root directory and its package.json script names. */
export function rootInfo(dir: string): { files: string[]; scripts: string[] } {
  const files = readdirSync(dir);
  let scripts: string[] = [];
  if (files.includes('package.json')) {
    try {
      scripts = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {});
    } catch {
      // unreadable package.json: no scripts
    }
  }
  return { files, scripts };
}
