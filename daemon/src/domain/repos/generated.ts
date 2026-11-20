// Generated files: which paths a repo's command rebuilds, so a sync regenerates them rather than merging them.
import type { Repo } from '#domain/repos/repo.ts';

const escaped = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

function globPattern(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      const slash = glob.charAt(i + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += escaped(c);
  }
  return new RegExp(`^${source}$`);
}

function matchesGlob(path: string, glob: string): boolean {
  const trimmed = glob.trim().replace(/^\/+/, '');
  if (!trimmed) return false;
  return globPattern(trimmed).test(path) || globPattern(`${trimmed.replace(/\/+$/, '')}/**`).test(path);
}

interface GeneratedSplit {
  command: string | null;
  generated: string[];
  other: string[];
}

export function splitGenerated(repo: Pick<Repo, 'generated_paths' | 'generated_cmd'>, files: string[]): GeneratedSplit {
  const command = repo.generated_cmd?.trim() || null;
  if (!command) return { command, generated: [], other: files };
  const isGenerated = (file: string) => repo.generated_paths.some((glob) => matchesGlob(file, glob));
  return { command, generated: files.filter(isGenerated), other: files.filter((f) => !isGenerated(f)) };
}
