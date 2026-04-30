// In-memory store backing the "list recent runs" sidebar. The web UI does not
// yet drive workflow execution itself — runs originate from the CLI runtime —
// so until we wire up a persistent store (SQLite or the CLI's own state
// directory), this module hosts the canonical shape used by the repository
// adapter.
//
// Mirrors `workflows.ts`: the store is an interface with a tiny default
// implementation, and `repos.ts` wires the production instance. Tests inject
// their own implementation directly into the repository factory.

import type { RunSummaryRow } from '$features/workflow-editor/entities/runSummary';
import type { RunDetailRow } from '$features/workflow-editor/entities/runDetail';

/**
 * Underlying run store. Returns plain row shapes (no branded ids) so the
 * entity layer keeps ownership of brand validation via
 * `buildRunSummaryFromRow` / `buildRunDetailFromRow`.
 *
 * `findRecentByWorkflow` returns at most `limit` entries, ordered by
 * `startedAt` descending (newest first). Implementations MUST honour the
 * scenario's invariant 1 ("自分が指定したワークフローの履歴のみが返される")
 * — the workflow id filter is the responsibility of the store, not the
 * caller, so a future SQL-backed implementation cannot accidentally widen
 * the result set by forgetting a `WHERE` clause at the route layer.
 *
 * `findDetailById` returns the full per-node run detail for a single run,
 * or `null` if no run with the given id exists. The summary row and detail
 * row are stored independently so the in-memory implementation can serve
 * both views without duplicating data — a real backend would project them
 * from the same source of truth.
 */
export interface RunStore {
  /** Whether a workflow with the given id has any runs (or is otherwise known). */
  exists(workflowId: string): Promise<boolean>;
  /** Return the most recent runs for `workflowId`, newest first, capped at `limit`. */
  findRecentByWorkflow(workflowId: string, limit: number): Promise<RunSummaryRow[]>;
  /**
   * Return the per-node detail for a single run, or `null` if not found. The
   * scenario allows in-flight Runs to return a detail row whose nodes carry
   * `Pending` / `Running` statuses (invariant 1: "進行中の Run でも詳細を取得
   * できる") — implementations MUST NOT filter those out.
   */
  findDetailById(runId: string): Promise<RunDetailRow | null>;
}

/**
 * In-memory implementation. Module-level so multiple `+server.ts` request
 * handlers within the same Node process see a consistent view; the data is
 * lost on restart, which matches the current "no persistence" assumption.
 *
 * Synchronisation with the CLI runtime is out of scope for this module — when
 * a real backend lands, this file is the single seam that swaps over.
 */
const STORE: RunSummaryRow[] = [];
/**
 * Detail rows are keyed by `runId`. We deliberately use a separate map (not a
 * field on `RunSummaryRow`) so seeding a summary without details — the case
 * for the existing `list-recent-runs` E2E suite — keeps working unchanged.
 * Seeding details for a run that has no summary is also legal: a future
 * backend may stream detail rows before the summary aggregate has been
 * computed, and rejecting that here would couple two otherwise independent
 * read paths.
 */
const DETAIL_STORE: Map<string, RunDetailRow> = new Map();

export function createInMemoryRunStore(): RunStore {
  return {
    async exists(workflowId) {
      // The store does not (yet) own the workflow registry; that lives in
      // `WorkflowStore`. We therefore implement `exists` here as "we have at
      // least one run for this workflow", which is the only signal an
      // in-memory run store can offer. Routes pair this with the workflow
      // file repository (see `listRecentRunsWorkflow.deps.workflowExists`)
      // and pick whichever check is correct for the scenario — the
      // production wiring uses the file-based check so empty workflows still
      // return `RunList []` rather than `WorkflowNotFound`.
      return STORE.some((r) => r.workflowId === workflowId);
    },
    async findRecentByWorkflow(workflowId, limit) {
      // Defensive: a malformed `limit` from the route layer should never
      // panic the process. The route validates and clamps; we re-clamp here
      // so the store contract is "non-negative integer or treat as 0".
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
      if (safeLimit === 0) return [];
      // Filter then sort. The result set is always small (capped by
      // `safeLimit`) so the simple in-memory sort is fine even when the
      // backing array grows.
      return STORE.filter((r) => r.workflowId === workflowId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, safeLimit);
    },
    async findDetailById(runId) {
      const row = DETAIL_STORE.get(runId);
      return row ?? null;
    },
  };
}

/**
 * Test seam: append a synthetic run row. Not exported via `repos.ts`. Real
 * persistence will replace this entirely; until then the in-memory store
 * starts empty in production and tests/seed scripts can call this helper
 * directly.
 */
export function _appendRunRowForTesting(row: RunSummaryRow): void {
  STORE.push(row);
}

/**
 * Test seam: insert (or replace) a synthetic run-detail row keyed by `runId`.
 * Mirrors `_appendRunRowForTesting` — the detail map is the canonical source
 * for the read-run-detail panel, which the production code path can then
 * read back via `GET /api/workflows/:id/runs/:runId`.
 */
export function _setRunDetailRowForTesting(row: RunDetailRow): void {
  DETAIL_STORE.set(row.id, row);
}

/**
 * Test seam: clear the in-memory store. Used by unit tests that share the
 * module instance.
 */
export function _clearRunStoreForTesting(): void {
  STORE.length = 0;
  DETAIL_STORE.clear();
}
