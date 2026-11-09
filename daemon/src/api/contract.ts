// The HTTP API's request and response types: what the dashboard imports (app/src/api/types.ts) and what contract-check.ts
// holds the use cases to. The types are in contract/<context>.ts and re-exported here, so the dashboard imports one module.
// It imports only types, and only from domain/ and contract/, so the app can read it without node types.
import type { FileRef, LinkKind, TaskStatus } from '../domain/work/index.ts';
import type { NotifyKind } from '../domain/operations/index.ts';
import type { AutoMergeState, PrRetry, PrState } from '../domain/landing/index.ts';
import type { MergeMethod, PrMode } from '../domain/repos/index.ts';
import type { ClaimVerdict, VerifyFinding, VerifyView } from '../domain/runs/index.ts';

// ---- Vocabulary

// The domain's words, shared as they are.
export type { AutoMergeState, ClaimVerdict, FileRef, LinkKind, MergeMethod, NotifyKind, PrMode, PrRetry, PrState, TaskStatus };
export type { VerifyFinding, VerifyView };

export type * from './contract/repos.ts';
export type * from './contract/work.ts';
export type * from './contract/runs.ts';
export type * from './contract/landing.ts';
export type * from './contract/files.ts';
export type * from './contract/operations.ts';
export type * from './contract/insights.ts';
