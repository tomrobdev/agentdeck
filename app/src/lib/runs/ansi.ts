// Terminal colour codes (SGR) as styled segments: bold and the eight basic colours; any other code is dropped.

export interface AnsiSegment {
  text: string;
  bold: boolean;
  color: number | null;
}

const ESCAPE = /\u001b\[([0-9;]*)([A-Za-z])|\u001b[^[]?/g;

export function parseAnsi(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let bold = false;
  let color: number | null = null;
  let last = 0;
  const push = (end: number) => {
    if (end > last) out.push({ text: text.slice(last, end), bold, color });
  };
  for (const m of text.matchAll(ESCAPE)) {
    push(m.index);
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        bold = false;
        color = null;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) color = c - 30;
      else if (c === 39) color = null;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
  push(text.length);
  return out;
}
