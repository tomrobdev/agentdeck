// Watches the daemon's own source so it can notice it is running stale code.
import { watch } from 'node:fs';

export function watchSource(dir: string, onChange: (file: string) => void): () => void {
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    if (file && file.endsWith('.ts')) onChange(file);
  });
  watcher.on('error', () => watcher.close());
  watcher.unref();
  return () => watcher.close();
}
