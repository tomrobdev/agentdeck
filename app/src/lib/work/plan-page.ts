// A plan's page made ready for the dashboard's frame: plan.css put in, and readable defaults for a plan without styles.

type ModeKey = 'system' | 'light' | 'dark';

function baseStyle(m: ModeKey) {
  const scheme = m === 'system' ? 'light dark' : m;
  return `<style>
:root { color-scheme: ${scheme}; }
body { margin: 0; padding: 16px 20px; background: Canvas; color: CanvasText; font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
h1 { font-size: 1.5em; } h2 { font-size: 1.15em; margin-top: 1.4em; }
code, pre { font-family: ui-monospace, Menlo, monospace; }
</style>`;
}
const PLAN_CSS_LINK = /<link\b[^>]*\bhref=["']plan\.css["'][^>]*>/i;
export function withBaseStyle(page: string, mode: ModeKey, css: string) {
  const linksCss = PLAN_CSS_LINK.test(page);
  const style = baseStyle(linksCss ? 'light' : mode);
  const linked = page.replace(PLAN_CSS_LINK, () => `<style>${css}</style>`);
  const head = /<head[^>]*>/i.exec(linked);
  if (head) return linked.slice(0, head.index + head[0].length) + style + linked.slice(head.index + head[0].length);
  return linked.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + style);
}
