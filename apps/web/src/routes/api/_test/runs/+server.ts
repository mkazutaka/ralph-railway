// Test-only seed endpoint for the in-memory run store.
//
// The "list recent runs" sidebar is backed by a module-scoped in-memory
// store (see `$lib/server/runs.ts`). The web UI does not yet drive workflow
// execution itself, so end-to-end tests need a way to inject synthetic run
// rows that the production code path can then read back via the public
// `GET /api/workflows/:id/runs` endpoint. Without this seam, the only
// observable state for the panel would be the empty list and the error
// branch — we'd be unable to assert the populated rendering at all, which
// is the primary user story described in
// `apps/web/docs/scenarios/workflow-editor/list-recent-runs.md`.
//
// Hard guard: this endpoint refuses to serve unless the operator opts in
// via `RALPH_WEB_TEST_SEED=1`. The Playwright dev server sets the flag;
// production builds never do, so the route returns 404 and behaves as if
// it does not exist. We keep the gate inside the handler (rather than
// conditionally exporting the file) so a future refactor that drops the
// gate cannot silently expose the seam — the env check fires on every
// request.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  _appendRunRowForTesting,
  _clearRunStoreForTesting,
  _setRunDetailRowForTesting,
} from '$lib/server/runs';
import type { RunSummaryRow } from '$features/workflow-editor/entities/runSummary';
import type {
  NodeRunDetailRow,
  RunDetailRow,
} from '$features/workflow-editor/entities/runDetail';

function ensureEnabled() {
  // Defence-in-depth (review note L5): refuse to register this seam in
  // production builds even if `RALPH_WEB_TEST_SEED=1` accidentally leaks
  // into the environment. The seed endpoint mutates module-level state
  // directly; in a production image that would let any caller (within the
  // localhost guard) inject synthetic runs, breaking the integrity of the
  // recent-runs panel.
  if (process.env.NODE_ENV === 'production') {
    throw error(404, 'not found');
  }
  if (process.env.RALPH_WEB_TEST_SEED !== '1') {
    // 404 (not 403) so production deployments leak nothing about the
    // existence of this seam. A reverse proxy probing for test endpoints
    // sees the same response as for any unmapped path.
    throw error(404, 'not found');
  }
}

interface SeedBody {
  /** Replace the in-memory store atomically before seeding the new rows. */
  reset?: boolean;
  /** Rows to append after (optional) reset. Each must satisfy `RunSummaryRow`. */
  rows?: ReadonlyArray<RunSummaryRow>;
  /**
   * Per-run detail rows to upsert into the detail store. Each row must
   * satisfy `RunDetailRow`. Independent from `rows` so a test can seed only
   * the summary view (existing list-recent-runs behaviour) or only the
   * detail view (read-run-detail) without forcing the other shape.
   */
  details?: ReadonlyArray<RunDetailRow>;
}

function isValidNodeRow(row: unknown): row is NodeRunDetailRow {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.nodeId !== 'string') return false;
  if (typeof r.status !== 'string') return false;
  if (r.startedAt !== null && typeof r.startedAt !== 'number') return false;
  if (r.endedAt !== null && typeof r.endedAt !== 'number') return false;
  if (r.output !== null && typeof r.output !== 'string') return false;
  if (r.errorMessage !== null && typeof r.errorMessage !== 'string') return false;
  if (typeof r.logExcerpt !== 'string') return false;
  return true;
}

function isValidDetailRow(row: unknown): row is RunDetailRow {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  if (typeof r.workflowId !== 'string') return false;
  if (typeof r.status !== 'string') return false;
  if (typeof r.startedAt !== 'number') return false;
  if (r.endedAt !== null && typeof r.endedAt !== 'number') return false;
  if (!Array.isArray(r.nodes)) return false;
  for (const node of r.nodes) {
    if (!isValidNodeRow(node)) return false;
  }
  return true;
}

/**
 * POST /api/_test/runs — seed the in-memory run store.
 *
 * Body: `{ reset?: boolean; rows?: RunSummaryRow[] }`. Returns `{ ok: true,
 * appended: <n> }` on success.
 *
 * The endpoint validates only structural shape; branded validation happens
 * in `buildRunSummaryFromRow` when the production read path consumes the
 * row, which mirrors how a future SQL-backed store would behave (rows
 * pass through the entity boundary on read, not on write).
 */
export const POST: RequestHandler = async ({ request }) => {
  ensureEnabled();

  let body: SeedBody;
  try {
    body = (await request.json()) as SeedBody;
  } catch {
    throw error(400, 'invalid JSON body');
  }

  if (body.reset) {
    _clearRunStoreForTesting();
  }

  const rows = body.rows ?? [];
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      typeof row.id !== 'string' ||
      typeof row.workflowId !== 'string' ||
      typeof row.status !== 'string' ||
      typeof row.startedAt !== 'number' ||
      (row.durationMs !== null && typeof row.durationMs !== 'number')
    ) {
      throw error(400, 'invalid row shape');
    }
    _appendRunRowForTesting(row);
  }

  const details = body.details ?? [];
  for (const detail of details) {
    if (!isValidDetailRow(detail)) {
      throw error(400, 'invalid detail row shape');
    }
    _setRunDetailRowForTesting(detail);
  }

  return json({ ok: true, appended: rows.length, details: details.length });
};

/**
 * DELETE /api/_test/runs — clear the in-memory store. Convenience for
 * tests that want a clean slate without sending an empty seed payload.
 */
export const DELETE: RequestHandler = async () => {
  ensureEnabled();
  _clearRunStoreForTesting();
  return json({ ok: true });
};
