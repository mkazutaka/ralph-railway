// DTOs for the workflow-editor feature. Each DTO is a plain JSON-serializable
// object that crosses the entity → API boundary. Conversion is centralised
// here so server routes don't sprinkle ad-hoc casts (`t.id as string`) at the
// boundary.

import type { PatternTemplate } from './pattern';
import type { InsertedPattern } from './insertedPattern';
import type { CreatedWorkflow } from './createdWorkflow';
import type { SavedWorkflow } from './savedWorkflow';
import type { WorkflowSummary } from './workflowSummary';
import type { RunStatus, RunSummary } from './runSummary';
import type { NodeRunDetail, NodeRunStatus, RunDetail } from './runDetail';
import type { StartedRun } from './startedRun';
import type { StopAccepted } from './stopAccepted';
import type { NodeTestResult, NodeTestStatus } from './nodeTestResult';
import type { FlowEdge, FlowGraph, FlowNode, OpenedWorkflow } from './openedWorkflow';
import type { PatternId, WorkflowId, YamlSource } from './types';

export interface PatternEntryDto {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly supported: boolean;
}

export function toPatternEntryDto(template: PatternTemplate): PatternEntryDto {
  // Branded `PatternId` is a string at runtime; the cast here is the explicit
  // entity → DTO de-branding boundary.
  return {
    id: template.id as string,
    label: template.label,
    description: template.description,
    supported: template.supported,
  };
}

/**
 * DTO returned to the client after a successful pattern insertion.
 *
 * Field naming corresponds 1:1 with the scenario DMMF in
 * `docs/scenarios/workflow-editor/insert-pattern.md`:
 *
 *   data InsertedPattern = WorkflowId + PatternId + UpdatedYaml
 *
 * `updatedYaml` (not `yaml`) is intentional — review note M-1 flagged that the
 * previous field name `yaml` made it ambiguous whether the value was the
 * post-save canonical form or just the original echo. Keeping the scenario
 * name through the entity → DTO boundary lets readers trace
 * `UpdatedYaml → updatedYaml` without an extra renaming hop.
 */
export interface InsertedPatternDto {
  readonly workflowId: string;
  readonly patternId: string;
  readonly updatedYaml: string;
}

export function toInsertedPatternDto(value: InsertedPattern): InsertedPatternDto {
  return {
    workflowId: value.workflowId as string,
    patternId: value.patternId as string,
    updatedYaml: value.updatedYaml as string,
  };
}

export interface WorkflowSummaryDto {
  readonly id: string;
  readonly name: string;
}

export function toWorkflowSummaryDto(value: WorkflowSummary): WorkflowSummaryDto {
  return { id: value.id as string, name: value.name };
}

/**
 * DTO for a single recent-run row, returned by the "list recent runs"
 * endpoint. Field naming follows the scenario DMMF in
 * `apps/web/docs/scenarios/workflow-editor/list-recent-runs.md`:
 *
 *   data RunSummary = Id + WorkflowId + Status + StartedAt + DurationMs
 *
 * `durationMs` is `null` for in-flight runs (scenario invariant 4); the
 * type is therefore `number | null` rather than `number`.
 *
 * Co-located with `WorkflowSummaryDto` (review note n5) so workflow-scoped
 * DTOs cluster together and readers can scan the workflow surface in one
 * pass instead of jumping to the bottom of the file.
 */
export interface RunSummaryDto {
  readonly id: string;
  readonly workflowId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly durationMs: number | null;
}

export function toRunSummaryDto(value: RunSummary): RunSummaryDto {
  return {
    id: value.id as string,
    workflowId: value.workflowId as string,
    status: value.status,
    startedAt: value.startedAt,
    durationMs: value.durationMs,
  };
}

/**
 * DTO for a single node's run detail. Field naming follows the scenario
 * DMMF in `apps/web/docs/scenarios/workflow-editor/read-run-detail.md`.
 *
 * `errorMessage` is `null` unless the node failed (scenario invariant 2);
 * `logExcerpt` is the truncated display string (invariant 3) — the full log
 * is not exposed via this DTO.
 */
export interface NodeRunDetailDto {
  readonly nodeId: string;
  readonly status: NodeRunStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly output: string | null;
  readonly errorMessage: string | null;
  readonly logExcerpt: string;
}

export function toNodeRunDetailDto(value: NodeRunDetail): NodeRunDetailDto {
  return {
    nodeId: value.nodeId as string,
    status: value.status,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    output: value.output,
    errorMessage: value.errorMessage,
    logExcerpt: value.logExcerpt,
  };
}

/**
 * DTO returned by the "read run detail" endpoint. Mirrors the scenario's
 * `RunDetail` 1:1 with branded ids de-branded to plain strings so the
 * payload is JSON-serialisable without further conversion at the route
 * boundary.
 */
export interface RunDetailDto {
  readonly id: string;
  readonly workflowId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly nodes: ReadonlyArray<NodeRunDetailDto>;
}

export function toRunDetailDto(value: RunDetail): RunDetailDto {
  return {
    id: value.id as string,
    workflowId: value.workflowId as string,
    status: value.status,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    nodes: value.nodes.map(toNodeRunDetailDto),
  };
}

/**
 * DTO for the workflow editor's load() function. Carries the raw YAML
 * source plus the workflow id, both de-branded to plain strings so the page
 * component does not need to know about `WorkflowId` / `YamlSource`.
 *
 * Centralising this conversion (review note m-1) keeps the entity → DTO
 * de-branding inside `entities/dto.ts` instead of inline `as string` casts
 * inside the route file.
 */
export interface WorkflowEditorLoadDto {
  readonly id: string;
  readonly yaml: string;
}

export function toWorkflowEditorLoadDto(
  workflowId: WorkflowId,
  yaml: YamlSource,
): WorkflowEditorLoadDto {
  return { id: workflowId as string, yaml: yaml as string };
}

/**
 * DTO mirror of the `FlowNode` entity from the open-workflow scenario. Branded
 * `NodeId` is de-branded at this boundary so the editor canvas can consume
 * the payload without importing the brand.
 */
export interface FlowNodeDto {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
}

export function toFlowNodeDto(value: FlowNode): FlowNodeDto {
  return { id: value.id as string, label: value.label, kind: value.kind };
}

/**
 * DTO mirror of the `FlowEdge` entity from the open-workflow scenario.
 */
export interface FlowEdgeDto {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export function toFlowEdgeDto(value: FlowEdge): FlowEdgeDto {
  return {
    id: value.id,
    source: value.source as string,
    target: value.target as string,
  };
}

/**
 * DTO mirror of the `FlowGraph` entity from the open-workflow scenario.
 *
 * `parseError` is `null` on the success path (scenario invariant 2) — the
 * type therefore stays `string | null` rather than an optional, so the
 * client cannot accidentally distinguish "absent" from "explicitly null".
 */
export interface FlowGraphDto {
  readonly nodes: ReadonlyArray<FlowNodeDto>;
  readonly edges: ReadonlyArray<FlowEdgeDto>;
  readonly parseError: string | null;
}

export function toFlowGraphDto(value: FlowGraph): FlowGraphDto {
  return {
    nodes: value.nodes.map(toFlowNodeDto),
    edges: value.edges.map(toFlowEdgeDto),
    parseError: value.parseError,
  };
}

/**
 * DTO returned by the open-workflow scenario. Mirrors the scenario's
 * `WorkflowDocument` 1:1 with branded ids de-branded at the API boundary.
 *
 * The shape is owned by the DTO module rather than constructed inline in the
 * route, so future shape changes are localised. The page-level load function
 * consumes this directly via `+page.server.ts`.
 */
export interface OpenedWorkflowDto {
  readonly id: string;
  readonly name: string;
  readonly yaml: string;
  readonly graph: FlowGraphDto;
}

export function toOpenedWorkflowDto(value: OpenedWorkflow): OpenedWorkflowDto {
  return {
    id: value.id as string,
    name: value.name,
    yaml: value.yaml as string,
    graph: toFlowGraphDto(value.graph),
  };
}

/**
 * DTO returned from `POST /api/workflows`. Mirrors the DMMF declaration in
 * `apps/web/docs/scenarios/workflow-management/create-workflow.md`:
 *
 *   data CreatedWorkflow =
 *       Id: WorkflowId
 *       Name: string
 *
 * The shape is owned by the DTO module (review note m-5) rather than
 * constructed inline in the route, so future shape changes are localised. The
 * legacy single-field call site (`toCreatedWorkflowDto(workflowId)`) is kept
 * as a thin wrapper so existing routes continue to compile during the
 * scenario refactor.
 */
export interface CreatedWorkflowDto {
  readonly id: string;
  readonly name: string;
}

export function toCreatedWorkflowDtoFromEntity(value: CreatedWorkflow): CreatedWorkflowDto {
  return { id: value.id as string, name: value.name };
}

export function toCreatedWorkflowDto(workflowId: WorkflowId): CreatedWorkflowDto {
  const raw = workflowId as string;
  return { id: raw, name: raw.replace(/\.(ya?ml)$/, '') };
}

/**
 * DTO returned from `PUT /api/workflows/:id` (save-workflow scenario).
 * Mirrors the DMMF declaration in
 * `apps/web/docs/scenarios/workflow-management/save-workflow.md`:
 *
 *   data SavedWorkflow =
 *       Id: WorkflowId
 *       SavedAt: number
 *
 * Field naming (`savedAt` not `saved_at` / `timestamp`) preserves the
 * scenario term through the entity → DTO boundary so readers can trace
 * `SavedAt → savedAt` without an extra renaming hop.
 */
export interface SavedWorkflowDto {
  readonly id: string;
  readonly savedAt: number;
}

export function toSavedWorkflowDto(value: SavedWorkflow): SavedWorkflowDto {
  return { id: value.id as string, savedAt: value.savedAt };
}

/**
 * DTO returned to the client after a successful workflow run dispatch.
 *
 * Field naming corresponds 1:1 with the scenario DMMF in
 * `apps/web/docs/scenarios/workflow-editor/run-workflow.md`:
 *
 *   data StartedRun = Id: RunId + WorkflowId + StartedAt
 *
 * The DTO is deliberately minimal — progress / completion / per-node detail
 * belong to the read-run-detail scenario and are consumed via a separate
 * endpoint (scenario invariant 5: 実行開始は非同期).
 */
export interface StartedRunDto {
  readonly id: string;
  readonly workflowId: string;
  readonly startedAt: number;
}

export function toStartedRunDto(value: StartedRun): StartedRunDto {
  return {
    id: value.id as string,
    workflowId: value.workflowId as string,
    startedAt: value.startedAt,
  };
}

/**
 * DTO returned to the client after a successful stop-request dispatch.
 *
 * Field naming corresponds 1:1 with the scenario DMMF in
 * `apps/web/docs/scenarios/workflow-editor/stop-run.md`:
 *
 *   data StopAccepted = Id: RunId + RequestedAt: number
 *
 * The DTO is deliberately minimal — actual transition to `Cancelled` is
 * observed via the read-run-detail scenario (invariant 3). Returning the
 * post-stop run state from this endpoint would tempt callers to treat the
 * stop as synchronous, which it is not.
 */
export interface StopAcceptedDto {
  readonly id: string;
  readonly requestedAt: number;
}

export function toStopAcceptedDto(value: StopAccepted): StopAcceptedDto {
  return {
    id: value.id as string,
    requestedAt: value.requestedAt,
  };
}

/**
 * DTO returned to the client after a successful single-node test execution.
 *
 * Field naming corresponds 1:1 with the scenario DMMF in
 * `apps/web/docs/scenarios/workflow-editor/test-node.md`:
 *
 *   data NodeTestResult =
 *       NodeId + Status + Output + ErrorMessage + LogExcerpt + DurationMs
 *
 * `status` is the `NodeTestStatus` subset (`succeeded` | `failed`) — the
 * `Pending` / `Running` / `Skipped` / `Cancelled` members of the broader
 * `NodeRunStatus` enum are not possible end-states for an isolated, fully
 * synchronous node test. Modelling the constraint at the DTO level prevents
 * a future runtime adapter from accidentally returning a non-terminal
 * status across the API boundary.
 */
export interface NodeTestResultDto {
  readonly nodeId: string;
  readonly status: NodeTestStatus;
  readonly output: string | null;
  readonly errorMessage: string | null;
  readonly logExcerpt: string;
  readonly durationMs: number;
}

export function toNodeTestResultDto(value: NodeTestResult): NodeTestResultDto {
  return {
    nodeId: value.nodeId as string,
    status: value.status,
    output: value.output,
    errorMessage: value.errorMessage,
    logExcerpt: value.logExcerpt,
    durationMs: value.durationMs,
  };
}

/**
 * Plain-string context payload for `handleInsertPatternFailure`. Centralises
 * the entity → string de-branding (review note Minor 2) so route files don't
 * sprinkle `workflowId as string` casts inline. The failure handler only ever
 * needs the de-branded ids (it logs them and embeds them in error envelopes),
 * so accepting branded values here and producing strings keeps the contract
 * one-way.
 */
export interface InsertPatternFailureContextDto {
  readonly workflowId: string;
  readonly patternId: string;
}

export function toInsertPatternFailureContext(
  workflowId: WorkflowId,
  patternId: PatternId,
): InsertPatternFailureContextDto {
  return {
    workflowId: workflowId as string,
    patternId: patternId as string,
  };
}

