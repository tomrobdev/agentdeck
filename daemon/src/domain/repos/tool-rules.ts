// Checks a shell command against a repo's Bash(...) tool rules.

export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += c + cmd[++i];
      else {
        if (c === quote) quote = null;
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[++i];
    } else if (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if (cmd[i + 1] === c) i++;
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function bashPatterns(tools: string[]): string[] {
  return tools.flatMap((t) => {
    if (t === 'Bash') return ['*'];
    const m = t.match(/^Bash\((.*)\)$/s);
    return m ? [m[1]] : [];
  });
}

export function matchesRule(command: string, pattern: string): boolean {
  return pattern.endsWith('*') ? command.startsWith(pattern.slice(0, -1)) : command === pattern;
}

export function refusedCommands(cmd: string, tools: string[]): string[] {
  const patterns = bashPatterns(tools);
  return splitCommand(cmd).filter((part) => !patterns.some((p) => matchesRule(part, p)));
}
