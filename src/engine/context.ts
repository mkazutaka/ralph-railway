import { evaluate } from '../jq';
import { Scope } from './scope';

export interface ContextInit {
  input?: Record<string, unknown>;
  workDir?: string;
  signal?: AbortSignal;
}

/**
 * Optional hooks that runners (e.g. ClaudeRunner) may invoke to stream
 * per-message progress back to the Engine's event bus. The Engine binds
 * these right before dispatching `call:claude` and restores afterwards.
 */
export interface ClaudeEmitHooks {
  text?: (text: string) => void;
  thinking?: (text: string) => void;
  toolUse?: (toolUseId: string, name: string, input: Record<string, unknown>) => void;
  toolResult?: (toolUseId: string, content: string, isError: boolean) => void;
}

/**
 * Optional hooks that the shell runner invokes to stream stdout/stderr chunks
 * back to the Engine's event bus. The Engine binds these before dispatching
 * `run.shell` and restores afterwards.
 */
export interface ShellEmitHooks {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export class ExecutionContext {
  readonly input: Record<string, unknown>;
  readonly workDir: string;
  readonly outputs: Record<string, unknown>;
  readonly varScope: Scope;
  signal: AbortSignal | undefined;
  claudeEmit: ClaudeEmitHooks = {};
  shellEmit: ShellEmitHooks = {};

  constructor(init: ContextInit = {}, varScope?: Scope, outputs?: Record<string, unknown>) {
    this.input = init.input ?? {};
    this.workDir = init.workDir ?? process.cwd();
    this.signal = init.signal;
    this.varScope = varScope ?? new Scope();
    this.outputs = outputs ?? {};
  }

  recordOutput(name: string, value: unknown): void {
    this.outputs[name] = value;
  }

  async evalStr(expr: unknown): Promise<unknown> {
    if (typeof expr !== 'string') return expr;
    return evaluate(expr, this.jqContext());
  }

  async evalValue(value: unknown): Promise<unknown> {
    if (typeof value === 'string') return this.evalStr(value);
    if (Array.isArray(value)) return Promise.all(value.map((v) => this.evalValue(v)));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = await this.evalValue(v);
      return out;
    }
    return value;
  }

  iterScope(): ExecutionContext {
    return new ExecutionContext(
      { input: this.input, workDir: this.workDir, signal: this.signal },
      this.varScope.child(),
      this.outputs, // shared with parent
    );
  }

  forkScope(): ExecutionContext {
    // Isolated outputs per branch.
    return new ExecutionContext(
      { input: this.input, workDir: this.workDir, signal: this.signal },
      this.varScope.child(),
      {},
    );
  }

  private jqContext(): Record<string, unknown> {
    return { input: this.input, output: this.outputs, var: this.varScope.toObject() };
  }
}

export function mergeBranchOutputs(
  parent: ExecutionContext,
  branchOutputs: ReadonlyArray<Record<string, unknown>>,
): void {
  const seen = new Map<string, unknown[]>();
  for (const branch of branchOutputs) {
    for (const [k, v] of Object.entries(branch)) {
      const bucket = seen.get(k);
      if (bucket) {
        bucket.push(v);
      } else {
        seen.set(k, [v]);
      }
    }
  }
  for (const [k, values] of seen) {
    parent.outputs[k] = values.length === 1 ? values[0] : values;
  }
}
