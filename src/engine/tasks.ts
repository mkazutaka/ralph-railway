import type { Specification } from '@serverlessworkflow/sdk';

export type TaskKind = 'set' | 'call' | 'run' | 'for' | 'switch' | 'fork' | 'try' | 'do';

const KIND_KEYS: TaskKind[] = ['set', 'call', 'run', 'for', 'switch', 'fork', 'try', 'do'];

export interface NormalizedTask {
  name: string;
  kind: TaskKind;
  body: Record<string, any>;
}

export function normalizeTaskEntry(entry: Record<string, any>): NormalizedTask {
  const keys = Object.keys(entry);
  if (keys.length !== 1) {
    throw new Error(`task entry must have exactly one key, got: ${JSON.stringify(keys)}`);
  }
  const name = keys[0] as string;
  const body = entry[name];
  if (body == null || typeof body !== 'object') {
    throw new Error(`task body for ${name} must be an object`);
  }
  const kind = inferKind(body);
  return { name, kind, body };
}

export function normalizeTaskList(
  tasks: Specification.TaskList | ReadonlyArray<Record<string, any>> | undefined,
): NormalizedTask[] {
  if (!tasks) return [];
  return (tasks as ReadonlyArray<Record<string, any>>).map(normalizeTaskEntry);
}

function inferKind(body: Record<string, any>): TaskKind {
  for (const k of KIND_KEYS) {
    if (k in body) return k;
  }
  throw new Error(`unknown task kind; body has keys: ${Object.keys(body).join(', ')}`);
}
