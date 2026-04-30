// `OpenedWorkflow` is the entity returned by the open-workflow scenario once a
// workflow YAML has been located on disk and parsed into a visualisation
// graph. Mirrors the DMMF declaration in
// `apps/web/docs/scenarios/workflow-management/open-workflow.md`:
//
//   data WorkflowDocument =
//       Id: WorkflowId
//       Name: string
//       Yaml: YamlSource
//       Graph: FlowGraph
//
//   data FlowGraph =
//       Nodes: FlowNode[]
//       Edges: FlowEdge[]
//       ParseError: string OR null
//
// We name the entity `OpenedWorkflow` instead of `WorkflowDocument` because the
// latter is already taken by the parsed-YAML structure in
// `entities/workflowDocument.ts` (the in-memory mapping/tasks shape used by
// `mergePatternIntoDocument`). Keeping the names distinct prevents accidental
// imports across two unrelated concepts that happen to share a scenario noun.

import type { NodeId, WorkflowId, YamlSource } from './types';
import { asNodeId, InvalidBrandedValueError } from './types';

/**
 * Single node in the read-only flow visualisation. The `kind` field carries
 * the DSL action keyword (`do`, `set`, `call`, ...) so the UI can pick an
 * icon/colour without re-parsing the task body.
 */
export interface FlowNode {
  readonly id: NodeId;
  readonly label: string;
  readonly kind: string;
}

/**
 * Directed edge between two nodes. The current rendering policy chains the
 * `do` list sequentially (one edge per adjacent pair); branch / fork / loop
 * topology is out of scope for this scenario and lands separately.
 */
export interface FlowEdge {
  readonly id: string;
  readonly source: NodeId;
  readonly target: NodeId;
}

/**
 * Graph payload for the editor canvas.
 *
 * Invariant 2 from the scenario: when YAML parsing fails, the graph is
 * **empty** (not the last successfully parsed graph) and `parseError` carries
 * a human-readable reason. We model this explicitly so callers cannot
 * accidentally render a stale graph alongside an error banner.
 */
export interface FlowGraph {
  readonly nodes: ReadonlyArray<FlowNode>;
  readonly edges: ReadonlyArray<FlowEdge>;
  readonly parseError: string | null;
}

/**
 * Workflow-scoped envelope returned by the open-workflow scenario.
 *
 * Field naming follows the scenario's `WorkflowDocument` 1:1 (we rename the
 * type only, not the fields). Branding is preserved across the boundary so
 * the workflow / route layers cannot accidentally swap a `WorkflowId` for an
 * unbranded string.
 */
export interface OpenedWorkflow {
  readonly id: WorkflowId;
  readonly name: string;
  readonly yaml: YamlSource;
  readonly graph: FlowGraph;
}

/**
 * Strip the `.yaml` / `.yml` extension from a workflow id to produce the
 * default display name. Mirrors `newCreatedWorkflow` / `extractWorkflowSummary`
 * so the post-create, listing, and post-open displays use the same convention.
 */
function basenameOf(id: WorkflowId): string {
  return (id as string).replace(/\.(ya?ml)$/, '');
}

/**
 * Build an `OpenedWorkflow` from the already-branded inputs returned by the
 * dependencies. The display name follows the same fallback policy as the
 * listing scenario: prefer `document.name` from the parsed YAML if available,
 * otherwise fall back to the file basename.
 */
export function newOpenedWorkflow(
  id: WorkflowId,
  yaml: YamlSource,
  graph: FlowGraph,
  documentName: string | null,
): OpenedWorkflow {
  const name =
    documentName !== null && documentName.length > 0 ? documentName : basenameOf(id);
  return { id, name, yaml, graph };
}

/**
 * Re-validate a node id sourced from the parser before lifting it into the
 * branded `FlowNode`. The parser already enforces "exactly one key per task"
 * so the cast is in principle redundant, but re-branding here keeps the entity
 * layer self-defending against a future parser implementation that forgets
 * the check.
 */
export function asFlowNodeId(rawId: string): NodeId {
  try {
    return asNodeId(rawId);
  } catch (e) {
    if (e instanceof InvalidBrandedValueError) {
      throw new Error(`workflow yaml yielded an invalid node id "${rawId}": ${e.reason}`);
    }
    throw e;
  }
}
