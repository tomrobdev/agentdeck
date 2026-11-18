// The capacity context's interface: what other contexts and the layers above import.
export { BUDGET_KEYS, DEFAULT_BUDGET, decide, validateBudget, validateSlots } from '#domain/capacity/governor.ts';
export type { Budget, Decision } from '#domain/capacity/governor.ts';
export { NOT_DRAINING, drainedMessage, inFlightLine, isDraining, mayStart } from '#domain/capacity/drain.ts';
export type { Draining, InFlight } from '#domain/capacity/drain.ts';
export { quotaSpends } from '#domain/capacity/quota.ts';
export type { QuotaSample } from '#domain/capacity/quota.ts';
