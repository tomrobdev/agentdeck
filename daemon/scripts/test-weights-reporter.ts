// A node:test reporter that prints how long each test file took, as the JSON `pnpm coverage --weigh` saves for balancing shards.
import { join, relative } from 'node:path';
import type { TestEvent } from 'node:test/reporters';

const DAEMON = join(import.meta.dirname, '..');

export default async function* weights(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const took = new Map<string, number>();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details } = event.data;
    if (nesting === 0 && file) took.set(file, (took.get(file) ?? 0) + details.duration_ms);
  }
  const entries = [...took].map(([file, ms]) => [relative(DAEMON, file), Math.max(100, Math.round(ms / 100) * 100)] as const);
  yield `${JSON.stringify(Object.fromEntries(entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))), null, 2)}\n`;
}
