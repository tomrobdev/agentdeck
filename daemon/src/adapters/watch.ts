// Watches the daemon's own source so it can notice it is running stale code.
import { watch } from 'node:fs';

/** Call `onChange` with the relative path of each changed .ts file under `dir`. Returns a function that stops watching. */
export function watchSource(dir: string, onChange: (file: string) => void): () => void {
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    if (file && file.endsWith('.ts')) onChange(file);
  });
  watcher.unref();
  return () => watcher.close();
}
