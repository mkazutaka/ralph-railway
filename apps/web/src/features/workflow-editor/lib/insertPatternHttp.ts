// Shared HTTP / form-action mapping for the `insertPatternWorkflow` output.
//
// The same sum-type result is consumed by both the REST endpoint
// (`routes/api/workflows/[id]/patterns/+server.ts`) and the page-level form
// action (`routes/workflows/[id]/+page.server.ts`). Centralising the mapping
// here keeps the status / message contract in one place so adding a new
// output variant (or changing a status code) cannot drift between the two
// surfaces. Each consumer still owns its own `switch` on the result so
// TypeScript's exhaustiveness checks remain in force at the call sites.

import type { InsertPatternOutput } from '../workflows/insertPatternWorkflow';

export interface InsertPatternHttpFailure {
  readonly status: number;
  readonly message: string;
  /**
   * `'warn'` for user-recoverable issues (`invalidBaseYaml`, `idConflict`),
   * `'error'` for genuine server-side faults (`templateMalformed`,
   * `persistFailed`). Routes use this to decide whether to surface a stack
   * trace context-line in the server logs.
   */
  readonly logLevel: 'warn' | 'error' | null;
}

/**
 * Translate a non-success `InsertPatternOutput` variant into the HTTP status
 * + user-facing message that both the REST handler and the form action
 * return. The `patternInserted` variant is intentionally excluded: each
 * caller serialises the success payload differently (JSON DTO for REST,
 * `ActionResult` for the form action).
 */
export function mapInsertPatternFailure(
  result: Exclude<InsertPatternOutput, { kind: 'patternInserted' }>,
): InsertPatternHttpFailure {
  switch (result.kind) {
    case 'workflowNotFound':
      return { status: 404, message: 'workflow not found', logLevel: null };
    case 'unknownPattern':
      // Log unknown pattern probes at `warn` (review note m-5): a pattern id
      // that passes the regex but does not exist in the registry is either a
      // stale client or a bug-shaped probe. Surfacing it in the server log
      // means operators can detect probing without changing the user-facing
      // contract.
      return { status: 404, message: 'unknown pattern', logLevel: 'warn' };
    case 'unsupportedPattern':
      return {
        status: 409,
        message: 'pattern is not supported by the runtime',
        logLevel: null,
      };
    case 'invalidBaseYaml':
      // Detailed reason is logged server-side only; the client message
      // stays generic but stable enough for tests.
      return { status: 422, message: 'base workflow YAML is invalid', logLevel: 'warn' };
    case 'idConflict':
      // Surface a recovery hint instead of the bare technical phrase. The
      // user sees this text inside the picker's `role="alert"` region, so
      // it has to tell them what to do next (review note m2). The
      // technical phrase is preserved in the prefix so server-log greps
      // and existing assertions that look for it still match.
      return {
        status: 409,
        message:
          'unable to allocate unique task ids — your workflow has many steps with the same name. Rename a few existing steps before retrying.',
        logLevel: null,
      };
    case 'templateMalformed':
      return {
        status: 500,
        message: 'pattern template registry is malformed',
        logLevel: 'error',
      };
    case 'persistFailed':
      return { status: 500, message: 'failed to persist workflow', logLevel: 'error' };
  }
}
