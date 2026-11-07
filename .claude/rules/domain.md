---
paths:
  - 'daemon/src/domain/**'
---

# Working in `domain/`

How-to only. The rule statements (pure, no imports from other layers) are in CLAUDE.md.

- Model a thing as a type and the decisions about it as functions from values to values. No classes, no enums.
- One folder per aggregate. Put a new decision beside the type it decides about, not in `db/` or `application/`.
- Take the clock, random ids and anything else impure as arguments (`time.ts` has the shared helpers).
- Use the words in CLAUDE.md's Domain language in names and in user-facing text built here.
- A test calls the function with plain values; no database, no fakes. Name the rule it checks.
- Changing a type used by a table or by `api/contract.ts`: follow the `model-change` skill.
