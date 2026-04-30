// Test-only endpoint to toggle the in-memory runtime adapter's availability.
//
// The "Start Run" scenario (`apps/web/docs/scenarios/workflow-editor/run-workflow.md`)
// has a `RuntimeUnavailable` failure mode: when the runtime is unreachable,
// the route returns 503 and the UI surfaces an inline error. The production
// adapter (`createInMemoryRuntimeStore` in `$lib/server/runtime.ts`) is
// always available because no real daemon is wired in yet, so the failure
// path can only be exercised end-to-end if we can flip the in-memory flag.
//
// Mirrors the `_test/runs` seed endpoint:
//   - Hard guard: `RALPH_WEB_TEST_SEED=1` must be set; otherwise 404 (so a
//     misconfigured production deployment leaks nothing about this seam).
//   - Mutates the shared module-level state in `$lib/server/runtime.ts` via
//     the `_setRuntimeAvailableForTesting` test seam.
//   - The flag is process-wide; tests must reset it in `afterEach` to keep
//     other specs green.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  _setRuntimeAvailableForTesting,
  _setTestNodeForcedFailureForTesting,
} from '$lib/server/runtime';

function ensureEnabled() {
  // Defence-in-depth (review note L5): the seed flag alone is not enough.
  // A production image where an operator accidentally inherits
  // `RALPH_WEB_TEST_SEED=1` would otherwise expose a remote knob that lets
  // any caller (within the localhost guard) flip the runtime to
  // `unavailable`, causing a trivial DoS for legitimate requests. We refuse
  // to register the seam in production builds regardless of the env flag.
  if (process.env.NODE_ENV === 'production') {
    throw error(404, 'not found');
  }
  if (process.env.RALPH_WEB_TEST_SEED !== '1') {
    throw error(404, 'not found');
  }
}

interface RuntimeBody {
  available?: boolean;
  /**
   * Optional: when provided, force `executeNodeOnce` (single-node test
   * execution) to surface results as `failed` with this error message.
   * Pass `null` to revert to the default `succeeded` synthesis. Used by
   * the test-node E2E spec (`apps/web/e2e/test-node.spec.ts`) to exercise
   * the UI's `failed` rendering branch. The flag is process-wide so
   * tests MUST reset it in `afterEach` (review note C-4).
   */
  testNodeForcedFailureMessage?: string | null;
}

/**
 * POST /api/_test/runtime — set the in-memory runtime's availability.
 *
 * Body: `{ available?: boolean, testNodeForcedFailureMessage?: string | null }`.
 * Either field is optional, but at least one must be provided. Returns
 * `{ ok: true, available: <bool>, testNodeForcedFailureMessage: <string|null> }`.
 */
export const POST: RequestHandler = async ({ request }) => {
  ensureEnabled();

  let body: RuntimeBody;
  try {
    body = (await request.json()) as RuntimeBody;
  } catch {
    throw error(400, 'invalid JSON body');
  }

  // Both fields are optional but at least one must be present so we cannot
  // accept silently no-op bodies (e.g. `{}`).
  const hasAvailable = body.available !== undefined;
  const hasFailure = body.testNodeForcedFailureMessage !== undefined;
  if (!hasAvailable && !hasFailure) {
    throw error(
      400,
      'expected { available: boolean } or { testNodeForcedFailureMessage: string | null }',
    );
  }

  if (hasAvailable) {
    if (typeof body.available !== 'boolean') {
      throw error(400, 'available must be a boolean');
    }
    _setRuntimeAvailableForTesting(body.available);
  }
  if (hasFailure) {
    const v = body.testNodeForcedFailureMessage;
    if (v !== null && typeof v !== 'string') {
      throw error(400, 'testNodeForcedFailureMessage must be a string or null');
    }
    _setTestNodeForcedFailureForTesting(v);
  }

  return json({
    ok: true,
    available: body.available ?? null,
    testNodeForcedFailureMessage: body.testNodeForcedFailureMessage ?? null,
  });
};
