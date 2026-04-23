import type { Specification } from '@serverlessworkflow/sdk';
import { getRunner } from '../runners/base';
// Ensure built-in runners register at Engine import time.
import '../runners/set';
import '../runners/call';
import '../runners/run';
import { ExecutionContext, mergeBranchOutputs } from './context';
import {
  TaskNotFoundError,
  UserCancelledError,
  WorkflowIterationLimitError,
  WorkflowTimeoutError,
} from './errors';
import { EngineBus, type TaskPath } from './events';
import { Jump } from './jumps';
import { type NormalizedTask, normalizeTaskList } from './tasks';

const JUMP_KEYWORDS = new Set(['exit', 'end', 'continue']);

interface RetryCfg {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
}

interface FileTrigger {
  name: string;
  path: string;
  then: string;
}

export class Engine {
  constructor(public readonly bus: EngineBus = new EngineBus()) {}

  async runWorkflow(
    wf: Specification.Workflow,
    init: { input?: Record<string, unknown>; workDir?: string } = {},
  ): Promise<Record<string, unknown>> {
    const tasks = normalizeTaskList(wf.do as any);
    const timeoutMs = extractTimeoutMs(wf);
    const triggers = parseFileTriggers((wf as any).on);

    const ctx = new ExecutionContext({ input: init.input, workDir: init.workDir });

    const run = async (): Promise<void> => {
      if (triggers.length === 0) {
        await this.runTaskList(tasks, ctx, []);
        return;
      }
      const { watchForFile } = await import('./file-trigger');
      const eventCtl = new AbortController();
      const linked = link(eventCtl.signal, ctx.signal);
      try {
        await Promise.race([
          this.runTaskList(tasks, ctx, []).then(() => {
            eventCtl.abort();
            return 'done' as const;
          }),
          watchForFile(triggers, linked).then(async (t) => {
            const idx = tasks.findIndex((task) => task.name === t.then);
            if (idx < 0) throw new TaskNotFoundError(`on.event -> unknown then: ${t.then}`);
            await this.runTaskList(tasks.slice(idx), ctx, []);
            return 'event' as const;
          }),
        ]);
      } finally {
        eventCtl.abort();
      }
    };

    if (timeoutMs !== null) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      ctx.signal = controller.signal;
      try {
        await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () =>
              reject(new WorkflowTimeoutError(`workflow exceeded ${timeoutMs}ms`)),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      await run();
    }
    return ctx.outputs;
  }

  async runTaskList(
    tasks: NormalizedTask[],
    ctx: ExecutionContext,
    path: TaskPath = [],
  ): Promise<void> {
    // Sibling tasks that share a name (e.g. two `greet:` entries in the same
    // `do:` list) would otherwise collide on their TaskPath key and the UI
    // reducer would fold the second start into the first row. Disambiguate
    // the 2nd+ occurrence by suffixing the path segment with `#N`; the UI
    // strips the suffix back off for display.
    const nameCounts = new Map<string, number>();
    let i = 0;
    while (i < tasks.length) {
      if (ctx.signal?.aborted) {
        throw new UserCancelledError('execution aborted');
      }
      const task = tasks[i];
      if (!task) break;
      const count = (nameCounts.get(task.name) ?? 0) + 1;
      nameCounts.set(task.name, count);
      const segment = count > 1 ? `${task.name}#${count}` : task.name;
      const result = await this.runTask(task, ctx, path, segment);
      if (result instanceof Jump) {
        const target = result.target;
        if (JUMP_KEYWORDS.has(target)) {
          if (target === 'exit' || target === 'end') return;
          // 'continue' falls through to next task
          i += 1;
          continue;
        }
        const idx = tasks.findIndex((t) => t.name === target);
        if (idx < 0) throw new TaskNotFoundError(`jump to unknown task: ${target}`);
        i = idx;
        continue;
      }
      i += 1;
    }
  }

  async runTask(
    task: NormalizedTask,
    ctx: ExecutionContext,
    path: TaskPath = [],
    segment?: string,
  ): Promise<unknown> {
    const taskPath: TaskPath = [...path, segment ?? task.name];
    // SLW v1.0.3: TaskBase.if is a runtime expression that determines whether
    // the task should be run. Falsy → skip without start/end so the trace
    // shows a single "skipped" entry instead of a phantom start.
    if (task.body.if != null) {
      const cond = await ctx.evalStr(task.body.if);
      if (!cond) {
        this.bus.emit({ kind: 'task:skip', path: taskPath, taskKind: task.kind });
        return null;
      }
    }
    const startedAt = Date.now();
    this.bus.emit({ kind: 'task:start', path: taskPath, taskKind: task.kind });
    try {
      const output = await this.dispatchTask(task, ctx, taskPath);
      this.bus.emit({
        kind: 'task:end',
        path: taskPath,
        taskKind: task.kind,
        durationMs: Date.now() - startedAt,
        output: output instanceof Jump ? undefined : output,
      });
      return output;
    } catch (err) {
      this.bus.emit({
        kind: 'task:error',
        path: taskPath,
        taskKind: task.kind,
        message: (err as Error).message,
      });
      throw err;
    }
  }

  private async dispatchTask(
    task: NormalizedTask,
    ctx: ExecutionContext,
    taskPath: TaskPath,
  ): Promise<unknown> {
    switch (task.kind) {
      case 'set':
      case 'call': {
        const runner = getRunner(task.kind);
        // Bind streaming hooks so the Claude runner can surface per-message
        // events through the bus under this task's path. Restore afterwards so
        // we don't pollute sibling tasks in the same ctx.
        const prev = ctx.claudeEmit;
        ctx.claudeEmit = {
          text: (text) => this.bus.emit({ kind: 'claude:text', path: taskPath, text }),
          thinking: (text) => this.bus.emit({ kind: 'claude:thinking', path: taskPath, text }),
          toolUse: (toolUseId, name, input) =>
            this.bus.emit({ kind: 'claude:tool_use', path: taskPath, toolUseId, name, input }),
          toolResult: (toolUseId, content, isError) =>
            this.bus.emit({
              kind: 'claude:tool_result',
              path: taskPath,
              toolUseId,
              content,
              isError,
            }),
        };
        let output: unknown;
        try {
          output = await runner.run(ctx, task.body);
        } finally {
          ctx.claudeEmit = prev;
        }
        ctx.recordOutput(task.name, output);
        return output;
      }
      case 'run': {
        const runner = getRunner('run');
        const prev = ctx.shellEmit;
        ctx.shellEmit = {
          stdout: (chunk) => this.bus.emit({ kind: 'shell:stdout', path: taskPath, chunk }),
          stderr: (chunk) => this.bus.emit({ kind: 'shell:stderr', path: taskPath, chunk }),
        };
        let output: unknown;
        try {
          output = await runner.run(ctx, task.body);
        } finally {
          ctx.shellEmit = prev;
        }
        ctx.recordOutput(task.name, output);
        return output;
      }
      case 'do':
        await this.runTaskList(normalizeTaskList(task.body.do), ctx, taskPath);
        return null;
      case 'for':
        return this.runFor(task, ctx, taskPath);
      case 'switch':
        return this.runSwitch(task, ctx);
      case 'fork':
        return this.runFork(task, ctx, taskPath);
      case 'try':
        return this.runTry(task, ctx, taskPath);
    }
  }

  private async runFor(task: NormalizedTask, ctx: ExecutionContext, path: TaskPath): Promise<void> {
    const spec = task.body.for;
    const each = spec.each as string | undefined;
    const at = spec.at as string | undefined;
    const whileExpr = task.body.while as string | undefined;
    const items = (await ctx.evalStr(spec.in as string)) as unknown;
    if (!Array.isArray(items)) {
      throw new TypeError(`for/in must yield list, got ${typeof items}`);
    }
    const body = normalizeTaskList(task.body.do);
    const cap = Number(process.env.RALPH_MAX_ITERATIONS ?? '10000');
    for (let i = 0; i < items.length; i++) {
      // Yield to the macrotask queue so timers (workflow timeout) and external
      // abort signals can fire even when every iteration resolves synchronously.
      await new Promise<void>((r) => setImmediate(r));
      if (ctx.signal?.aborted) throw new UserCancelledError('execution aborted');
      if (i >= cap) {
        throw new WorkflowIterationLimitError(`for loop exceeded ${cap} iterations`);
      }
      const iter = ctx.iterScope();
      if (each) iter.varScope.bind(each, items[i]);
      if (at) iter.varScope.bind(at, i);
      // SLW v1.0.3: `while` is a continuation condition evaluated before each
      // iteration. When it becomes falsy the loop exits (the iteration is skipped).
      if (whileExpr != null && !(await iter.evalStr(whileExpr))) return;
      this.bus.emit({ kind: 'iteration:start', path, index: i, total: items.length });
      await this.runTaskList(body, iter, path);
    }
  }

  private async runSwitch(task: NormalizedTask, ctx: ExecutionContext): Promise<Jump> {
    const cases = task.body.switch as Array<Record<string, { when?: string; then: string }>>;
    let def: string | null = null;
    for (const item of cases) {
      for (const c of Object.values(item)) {
        if (c.when == null) {
          if (def == null) def = c.then;
          continue;
        }
        if (await ctx.evalStr(c.when)) return new Jump(c.then);
      }
    }
    if (def != null) return new Jump(def);
    throw new Error(`switch in ${task.name} had no matching case and no default`);
  }

  private async runFork(
    task: NormalizedTask,
    ctx: ExecutionContext,
    path: TaskPath,
  ): Promise<void> {
    const branches = (task.body.fork.branches as Array<Array<Record<string, any>>>).map((b) =>
      normalizeTaskList(b),
    );
    const branchCtxs = branches.map(() => ctx.forkScope());
    await Promise.all(
      branches.map((b, i) => this.runTaskList(b, branchCtxs[i] as ExecutionContext, path)),
    );
    mergeBranchOutputs(
      ctx,
      branchCtxs.map((c) => c.outputs),
    );
  }

  private async runTry(task: NormalizedTask, ctx: ExecutionContext, path: TaskPath): Promise<void> {
    const tryBody = normalizeTaskList(task.body.try);
    const catchBlock = (task.body.catch ?? null) as null | {
      as?: string;
      do?: ReadonlyArray<Record<string, any>>;
      retry?: any;
    };
    const retryCfg = extractRetry(catchBlock?.retry);

    const attempt = async () => this.runTaskList(tryBody, ctx, path);

    try {
      if (retryCfg.maxAttempts > 1) {
        await runWithRetry(attempt, retryCfg);
      } else {
        await attempt();
      }
    } catch (err) {
      if (!catchBlock) throw err;
      const asVar = catchBlock.as ?? 'e';
      const catchCtx = ctx.iterScope();
      catchCtx.varScope.bind(asVar, {
        type: (err as Error).name,
        message: (err as Error).message,
      });
      const doTasks = normalizeTaskList(catchBlock.do ?? []);
      await this.runTaskList(doTasks, catchCtx, path);
    }
  }
}

function extractRetry(spec: any): RetryCfg {
  if (!spec) {
    return { initialDelayMs: 1000, multiplier: 1, maxDelayMs: 60000, maxAttempts: 1 };
  }
  return {
    initialDelayMs: Number(spec.delay?.seconds ?? 1) * 1000,
    multiplier: Number(spec.backoff?.exponential?.multiplier ?? 1),
    maxDelayMs: Number(spec.backoff?.exponential?.maxDelay?.seconds ?? 60) * 1000,
    maxAttempts: Number(spec.limit?.attempt?.count ?? 1),
  };
}

async function runWithRetry<T>(factory: () => Promise<T>, cfg: RetryCfg): Promise<T> {
  let delay = cfg.initialDelayMs;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    try {
      return await factory();
    } catch (err) {
      lastErr = err;
      if (attempt === cfg.maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.min(delay, cfg.maxDelayMs)));
      delay *= cfg.multiplier;
    }
  }
  throw lastErr;
}

function extractTimeoutMs(wf: Specification.Workflow): number | null {
  const seconds = (wf as any).timeout?.after?.seconds;
  if (seconds == null) return null;
  return Number(seconds) * 1000;
}

function parseFileTriggers(on: any): FileTrigger[] {
  if (!on) return [];
  const out: FileTrigger[] = [];
  for (const [name, body] of Object.entries<any>(on)) {
    if (body?.file?.path && body?.then) {
      // biome-ignore lint/suspicious/noThenProperty: `then` is the SLW DSL field name
      out.push({ name, path: body.file.path, then: body.then });
    }
  }
  return out;
}

function link(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (a.aborted || b.aborted) ctl.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return ctl.signal;
}
