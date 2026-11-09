# ADR 0005: A few deep ports, not one per adapter function

Status: accepted, 2026-11-07

`application/` will depend on ports it owns, and there are few of them, each deep: one for git, one for GitHub, one for running `claude`, and so on, with a small interface hiding a lot of work (a sync, not `git merge` and `git status` as separate calls). A port per adapter function would mirror the adapters and add a layer that hides nothing. Tests use real git in a temporary repo and a fake `claude` (`daemon/test/fixtures/fake-claude.mjs`) rather than mocking each call, because mocks of git agree with the code under test and miss what git really does. The cost is slower tests than pure mocks, and a fake to keep honest.

## Consequences

- A new port needs a reason: a seam where two real implementations (real and fake) exist.
- Adapters keep importing `domain/` and `config.ts` only.
