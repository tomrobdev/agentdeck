// The plans in docs/plans/ are plans: each parses, links the shared stylesheet and brings no CSS of its own.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePlan } from '../src/domain/work/plan.ts';

const dir = join(import.meta.dirname, '../../docs/plans');
const plans = readdirSync(dir).filter((f) => f.endsWith('.html'));

test('there are plans to check, and plan.css beside them', () => {
  assert.ok(plans.length > 0);
  assert.ok(readFileSync(join(dir, 'plan.css'), 'utf8').length > 0);
});

for (const file of plans) {
  test(`${file} parses as a plan`, () => {
    const html = readFileSync(join(dir, file), 'utf8');
    const plan = parsePlan(html);
    assert.ok(plan, 'carries the plan marker');
    assert.ok(plan.title && plan.title !== 'Untitled plan');
    assert.match(html, /<link rel="stylesheet" href="plan\.css" \/>/);
    assert.ok(!/<style[\s>]/i.test(html), 'has no <style> block');
  });
}
