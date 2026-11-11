// pnpm rules: each rule in CLAUDE.md with the tests and the script that enforce it, or "unchecked: reason".
import { readRules } from '#scripts/lib/rules.ts';

for (const rule of readRules()) {
  console.log(rule.id);
  for (const t of rule.tests) console.log(`  ${t}`);
  if (rule.script !== null) console.log(`  script: ${rule.script}`);
  if (rule.unchecked !== null) console.log(`  unchecked: ${rule.unchecked}`);
  else if (!rule.tests.length) console.log('  NO CHECK: add a test or an UNCHECKED entry');
}
