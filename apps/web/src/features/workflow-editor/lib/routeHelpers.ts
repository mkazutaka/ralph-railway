// Route-layer helpers shared by the `+page.server.ts` form actions and the
// REST endpoints under `/api/workflows/`. The `parseWorkflowParam` helper
// previously existed in two places — keeping it here means changing the id
// validation only requires editing one file.

import { error } from '@sveltejs/kit';
import {
  asNodeId,
  asPatternId,
  asRunId,
  asWorkflowId,
  InvalidBrandedValueError,
  type NodeId,
  type PatternId,
  type RunId,
  type WorkflowId,
} from '../entities/types';

/**
 * Parse a route param into a branded `WorkflowId`. Throws a SvelteKit 400
 * `error` for missing or malformed input — callers never need to handle the
 * branded-value `try/catch` themselves.
 */
export function parseWorkflowParam(raw: string | undefined): WorkflowId {
  if (!raw) throw error(400, 'workflow id is required');
  try {
    return asWorkflowId(raw);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) throw error(400, 'invalid workflow id');
    throw e;
  }
}

/**
 * Parse a route param into a branded `RunId`. Throws a SvelteKit 400 `error`
 * for missing or malformed input — callers never need to handle the
 * branded-value `try/catch` themselves. Mirrors `parseWorkflowParam` so the
 * read-run-detail route validates the run id with the same shape contract
 * as the rest of the feature.
 */
export function parseRunIdParam(raw: string | undefined): RunId {
  if (!raw) throw error(400, 'run id is required');
  try {
    return asRunId(raw);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) throw error(400, 'invalid run id');
    throw e;
  }
}

/**
 * Parse a route param into a branded `NodeId`. Throws a SvelteKit 400 `error`
 * for missing or malformed input — callers never need to handle the
 * branded-value `try/catch` themselves. Mirrors `parseRunIdParam` so the
 * test-node route validates the node id with the same shape contract as
 * other id-bearing routes.
 */
export function parseNodeIdParam(raw: string | undefined): NodeId {
  if (!raw) throw error(400, 'node id is required');
  try {
    return asNodeId(raw);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) throw error(400, 'invalid node id');
    throw e;
  }
}

/**
 * Parse a request value into a branded `PatternId`. Used by both the REST
 * POST and the form action; both must reject the same set of inputs.
 */
export function parsePatternId(raw: string): PatternId {
  try {
    return asPatternId(raw);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) throw error(400, 'invalid patternId');
    throw e;
  }
}

/**
 * Result of a route-layer parse that wants to handle validation failures
 * inline (e.g. a SvelteKit form action which prefers `fail()` over `error()`
 * so the page stays mounted and the user sees a flash message instead of a
 * full-page error). Use the `safe*` variants below; they never throw.
 */
export type ParseSafeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * Non-throwing variant of `parseWorkflowParam`. Returns a discriminated
 * result so form actions can decide between `fail(400, ...)` and other
 * recovery paths instead of a 400 error page.
 */
export function safeParseWorkflowParam(raw: string | undefined): ParseSafeResult<WorkflowId> {
  if (!raw) return { ok: false, reason: 'workflow id is required' };
  try {
    return { ok: true, value: asWorkflowId(raw) };
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      return { ok: false, reason: 'invalid workflow id' };
    }
    throw e;
  }
}

/**
 * Non-throwing variant of `parsePatternId`. Mirrors `safeParseWorkflowParam`
 * so form actions can return a `fail(400, ...)` envelope on validation
 * errors instead of `error(400, ...)`.
 */
export function safeParsePatternId(raw: string): ParseSafeResult<PatternId> {
  try {
    return { ok: true, value: asPatternId(raw) };
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      return { ok: false, reason: 'invalid patternId' };
    }
    throw e;
  }
}

/**
 * Default page size for the recent-runs sidebar. Picked to match the typical
 * sidebar height on a 1080p display (~20 rows). Server-side cap (`MAX_LIMIT`)
 * exists primarily to bound response size — a request that asks for a larger
 * limit is clamped, not rejected.
 */
export const RECENT_RUNS_DEFAULT_LIMIT = 20;
export const RECENT_RUNS_MAX_LIMIT = 100;

/**
 * Parse a `?limit=N` query parameter into a bounded integer. Falls back to
 * `RECENT_RUNS_DEFAULT_LIMIT` when missing. Negative / NaN / non-integer
 * values are rejected so the workflow input contract ("Limit: number") is
 * upheld at the boundary instead of relying on the store to coerce.
 *
 * Returns the discriminated parse result (mirrors `safeParse*`) so the route
 * can decide between `error(400, ...)` and recovery.
 */
export function safeParseRecentRunsLimit(
  raw: string | null | undefined,
): ParseSafeResult<number> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: RECENT_RUNS_DEFAULT_LIMIT };
  }
  // `Number.parseInt` accepts trailing garbage ("10abc" → 10); use
  // `Number()` so the request is rejected unless the entire string is a
  // well-formed integer.
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, reason: 'limit must be an integer' };
  }
  if (n <= 0) {
    return { ok: false, reason: 'limit must be a positive integer' };
  }
  if (n > RECENT_RUNS_MAX_LIMIT) {
    // Clamp rather than reject: the route's contract is "you get at most
    // MAX_LIMIT rows", so silently capping is friendlier than 400ing a
    // pagination control that asked for more.
    return { ok: true, value: RECENT_RUNS_MAX_LIMIT };
  }
  return { ok: true, value: n };
}
