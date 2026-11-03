// A plan's page made ready for the dashboard's frame: plan.css put in, and readable defaults for a plan without styles.
// Pure: the dashboard's mode and the plan.css text come in as arguments.

// The dashboard's mode (platform/theme.ts), named here so this module needs nothing from the Tauri shell.
type ModeKey = 'system' | 'light' | 'dark';

// Readable defaults for a plan that brings no styles of its own. Put first in <head>, so a plan's own CSS wins.
// The dashboard's mode decides the colour scheme: a plan follows the system only when the dashboard does.
function baseStyle(m: ModeKey) {
  const scheme = m === 'system' ? 'light dark' : m;
  return `<style>
:root { color-scheme: ${scheme}; }
body { margin: 0; padding: 16px 20px; background: Canvas; color: CanvasText; font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
h1 { font-size: 1.5em; } h2 { font-size: 1.15em; margin-top: 1.4em; }
code, pre { font-family: ui-monospace, Menlo, monospace; }
</style>`;
}
// A plan links plan.css, which a relative link can't reach from srcdoc: put the same file in where the link stood.
// Such a plan always renders light, whatever the dashboard's mode; one without it follows the mode.
const PLAN_CSS_LINK = /<link\b[^>]*\bhref=["']plan\.css["'][^>]*>/i;
export function withBaseStyle(page: string, mode: ModeKey, css: string) {
  const linksCss = PLAN_CSS_LINK.test(page);
  const style = baseStyle(linksCss ? 'light' : mode);
  const linked = page.replace(PLAN_CSS_LINK, () => `<style>${css}</style>`);
  const head = /<head[^>]*>/i.exec(linked);
  if (head) return linked.slice(0, head.index + head[0].length) + style + linked.slice(head.index + head[0].length);
  return linked.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + style);
}
