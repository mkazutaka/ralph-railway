// `StopAccepted` is the entity returned to the caller after a stop request has
// been successfully forwarded to the runtime. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-editor/stop-run.md`:
//
//   data StopAccepted =
//       Id: RunId
//       RequestedAt: number
//
// The entity is intentionally minimal: scenario invariant 2 ("停止は非同期要求
// であり、本ワークフローの完了は『要求の受理』までを保証する") and invariant 3
// ("実際に Cancelled 状態へ遷移したかは別ワークフロー (実行状態購読) で観測する")
// mean the stop-run scenario MUST NOT report final state — that is read via
// the read-run-detail scenario.

import type { RunId } from './types';
import { asRunId, InvalidBrandedValueError } from './types';

export interface StopAccepted {
  readonly id: RunId;
  /** Unix epoch in milliseconds, set when the runtime accepted the stop request. */
  readonly requestedAt: number;
}

/**
 * Plain row shape returned by the underlying runtime adapter. Branded
 * validation happens here in `buildStopAcceptedFromRow` so the workflow /
 * route layers can rely on every `StopAccepted` having already passed the
 * invariant checks.
 */
export interface StopAcceptedRow {
  readonly id: string;
  readonly requestedAt: number;
}

/**
 * Convert a raw runtime-adapter row into the entity. We re-validate the run
 * id and the timestamp here even though the adapter *should* only emit valid
 * values — a future swap of the underlying runtime (in-memory → CLI socket →
 * REST proxy) could regress and we'd rather surface a typed error than let
 * an unsafe value reach the workflow layer.
 *
 * Mirrors `buildStartedRunFromRow` (CLAUDE.md: "DB rows never leak past the
 * repository — convert via `buildXxxFromRow()` first").
 */
export function buildStopAcceptedFromRow(row: StopAcceptedRow): StopAccepted {
  let id: RunId;
  try {
    id = asRunId(row.id);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(
        `runtime adapter yielded an invalid StopAccepted row (id="${row.id}"): ${e.reason}`,
      );
    }
    throw e;
  }

  if (!Number.isFinite(row.requestedAt) || row.requestedAt < 0) {
    throw new Error(
      `runtime adapter yielded an invalid requestedAt (id="${row.id}", requestedAt=${row.requestedAt})`,
    );
  }

  return { id, requestedAt: row.requestedAt };
}
