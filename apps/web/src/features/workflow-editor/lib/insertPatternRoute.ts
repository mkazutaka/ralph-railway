// Shared route-layer handling for the `insertPatternWorkflow` output.
//
// Both the page-level form action (`routes/workflows/[id]/+page.server.ts`)
// and the REST endpoint (`routes/api/workflows/[id]/patterns/+server.ts`)
// consume the same `InsertPatternOutput` discriminated union. Without a
// shared module, each surface re-implements the `switch` over `result.kind`
// to do logging + status mapping, which means a new variant can drift between
// the two. This module owns the entire side-effecting reaction (logging) plus
// the status / message contract (delegated to `mapInsertPatternFailure`).
//
// Each route still owns its serialisation (JSON DTO vs. ActionResult), which
// is why this returns a typed `{ status, message }` envelope instead of a
// concrete `Response`.
//
// Note: the return type intentionally narrows out `patternInserted` so any
// caller that forgets to branch on success first will fail to type-check.

import type { InsertPatternOutput } from '../workflows/insertPatternWorkflow';
import { mapInsertPatternFailure } from './insertPatternHttp';

export interface InsertPatternFailureContext {
  readonly workflowId: string;
  readonly patternId: string;
}

export interface InsertPatternRouteFailure {
  readonly status: number;
  readonly message: string;
}

/**
 * Build the structured payload that accompanies a logged failure variant.
 * Returns `null` for variants that don't carry a server-side reason — those
 * are status-code-only outcomes (404 / 409) the user can act on without any
 * operator visibility.
 *
 * Kept separate from `handleInsertPatternFailure` so the only place that
 * knows which fields go into the log entry is here. New variants that need
 * logging just add a case below; the dispatch in `handleInsertPatternFailure`
 * stays driven by `mapInsertPatternFailure`'s `logLevel` (review note Q-5,
 * which flagged the previous duplicate switch as a drift hazard).
 */
function buildFailureLogPayload(
  result: Exclude<InsertPatternOutput, { kind: 'patternInserted' }>,
  ctx: InsertPatternFailureContext,
): Record<string, unknown> | null {
  switch (result.kind) {
    case 'invalidBaseYaml':
      return { workflowId: ctx.workflowId, reason: result.reason };
    case 'templateMalformed':
      return { patternId: ctx.patternId, reason: result.reason };
    case 'persistFailed':
      return { workflowId: ctx.workflowId, reason: result.reason };
    case 'unknownPattern':
      // Log enough context to detect probing (review note m-5) without
      // echoing an attacker-supplied id back to the client.
      return { workflowId: ctx.workflowId, patternId: ctx.patternId };
    case 'workflowNotFound':
    case 'unsupportedPattern':
    case 'idConflict':
      return null;
  }
}

/**
 * Map a non-success `InsertPatternOutput` to `{ status, message }` while
 * emitting the appropriate console log for the variant. Pure with respect to
 * its inputs apart from the controlled console call — matches the previous
 * inline behaviour in both `+page.server.ts` and `+server.ts` exactly.
 *
 * Logging is driven by `mapInsertPatternFailure`'s `logLevel`: a single
 * source of truth controls both the HTTP contract and the log severity, so
 * adding a new failure variant cannot leave the two surfaces out of sync
 * (review note Q-5).
 *
 * Exhaustiveness is delegated entirely to `mapInsertPatternFailure`'s
 * `switch`: TypeScript already errors at compile-time if a new
 * `InsertPatternOutput` variant lands without a corresponding case there
 * (review note Minor 3 — the previous runtime `assertNever` guard was dead
 * code because `mapInsertPatternFailure`'s return type cannot be
 * `undefined`). Keeping a single exhaustiveness gate makes "where to add a
 * new case" unambiguous.
 */
export function handleInsertPatternFailure(
  result: Exclude<InsertPatternOutput, { kind: 'patternInserted' }>,
  ctx: InsertPatternFailureContext,
): InsertPatternRouteFailure {
  const failure = mapInsertPatternFailure(result);
  if (failure.logLevel) {
    const payload = buildFailureLogPayload(result, ctx);
    if (payload) {
      // Tests assert that detailed `reason` strings never reach the client,
      // so the server log is the canonical place to inspect them.
      const tag = `[insertPattern] ${result.kind}`;
      if (failure.logLevel === 'warn') {
        console.warn(tag, payload);
      } else {
        console.error(tag, payload);
      }
    }
  }
  return { status: failure.status, message: failure.message };
}
