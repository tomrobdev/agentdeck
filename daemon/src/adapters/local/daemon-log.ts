// Reads the end of the daemon's log file.
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

export function readLogTail(path: string, maxBytes = 4 * 1024 * 1024): string[] | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    return size > length ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}
