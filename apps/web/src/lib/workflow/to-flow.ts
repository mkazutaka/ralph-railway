import yaml from 'js-yaml';

export interface FlowNode {
  id: string;
  data: { label: string; kind: string };
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  error?: string;
}

const TASK_KINDS = ['set', 'call', 'run', 'for', 'switch', 'fork', 'try', 'do'] as const;
const NODE_GAP_Y = 96;

function detectKind(task: Record<string, unknown>): string {
  for (const k of TASK_KINDS) if (k in task) return k;
  return 'unknown';
}

export function yamlToFlow(source: string): FlowGraph {
  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch (e) {
    return { nodes: [], edges: [], error: (e as Error).message };
  }

  const list = (parsed as { do?: Array<Record<string, unknown>> } | null)?.do;
  if (!Array.isArray(list)) {
    return { nodes: [], edges: [], error: 'missing top-level `do` list' };
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let prev: string | null = null;
  let y = 0;

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const keys = Object.keys(entry);
    if (keys.length !== 1) continue;
    const name = keys[0]!;
    const body = (entry as Record<string, unknown>)[name];
    if (!body || typeof body !== 'object') continue;
    const kind = detectKind(body as Record<string, unknown>);
    nodes.push({ id: name, data: { label: name, kind }, position: { x: 0, y } });
    if (prev) edges.push({ id: `${prev}->${name}`, source: prev, target: name });
    prev = name;
    y += NODE_GAP_Y;
  }

  return { nodes, edges };
}
