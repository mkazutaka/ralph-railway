import type { ExecutionContext } from '../engine/context';

export interface TaskRunner {
  run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown>;
}

export type RunnerFactory = () => TaskRunner;

const registry = new Map<string, RunnerFactory>();

export function registerRunner(kind: string, factory: RunnerFactory): void {
  registry.set(kind, factory);
}

export function getRunner(kind: string): TaskRunner {
  const f = registry.get(kind);
  if (!f) throw new Error(`no runner registered for kind: ${kind}`);
  return f();
}

export function hasRunner(kind: string): boolean {
  return registry.has(kind);
}

export function clearRegistry(): void {
  registry.clear();
}

export function snapshotRegistry(): string[] {
  return [...registry.keys()];
}
