import type { EngineEvent, TaskPath } from '../../engine/events';
import type {
  ActivityEntryToolResult,
  ActivityEntryToolUse,
  LogEntry,
  TaskEntry,
} from '../types/entries';
import type { ActivityId, TaskId } from '../types/ids';

export type {
  ActivityEntry,
  ActivityEntryShellStderr,
  ActivityEntryShellStdout,
  ActivityEntryText,
  ActivityEntryThinking,
  ActivityEntryToolResult,
  ActivityEntryToolUse,
  LogEntry,
  TaskEntry,
  TaskEntryIteration,
  TaskEntryTaskEnd,
  TaskEntryTaskError,
  TaskEntryTaskSkip,
  TaskEntryTaskStart,
} from '../types/entries';

const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_TEXT_BUFFER_BYTES = 64 * 1024;

type RunningActivityKindStream = 'text' | 'thinking' | 'shell-stdout' | 'shell-stderr';

export type RunningActivity =
  | { kind: RunningActivityKindStream; activityId: ActivityId; text: string }
  | {
      kind: 'read-group';
      uses: ActivityEntryToolUse[];
      results: Map<ActivityId, ActivityEntryToolResult>;
    }
  | { kind: 'tool'; use: ActivityEntryToolUse };

export interface RunningTask {
  taskId: TaskId;
  name: string;
  startedAt: number;
  activityMap: Map<ActivityId, RunningActivity>;
  runningActivities: RunningActivity[];
}

export interface State {
  taskMap: Map<TaskId, RunningTask>;
  runningTasks: RunningTask[];
  totalTasks: number;
  completedTasks: number;
  erroredTasks: number;
  costUsd: number;
  startedAt: number;
  revision: number;
}

function nameOf(path: TaskPath): string {
  // Strip the `#N` disambiguation suffix the executor adds for duplicate-name siblings.
  const last = path[path.length - 1] ?? '(root)';
  return last.replace(/#\d+$/, '');
}

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.max(64, Math.floor((max - 64) / 2));
  return `${s.slice(0, half)}\n... [${s.length - max} chars truncated] ...\n${s.slice(s.length - half)}`;
}

function appendBounded(buf: string | null, chunk: string, max: number): string {
  const next = (buf ?? '') + chunk;
  return next.length > max ? truncateString(next, max) : next;
}

let nextActivityCounter = 0;
function nextActivityId(): ActivityId {
  nextActivityCounter += 1;
  return `a${nextActivityCounter}`;
}

// One chunk = one logical row group. The grouping intent is encoded by the
// chunk's contents: a single entry, a tool-use+result pair, or a Read group
// (≥2 Read uses with their results). The render layer (RenderItemRow)
// converts chunks into RenderItems.
export type StdOutWrite = (entries: LogEntry[]) => void;

// Owns event handling outside React so writes can run synchronously inside
// dispatch. Doing it from `useEffect` would re-enter Ink's reconciler and
// crash yoga; using `<Static>` would retain every RenderItem forever.
export class EngineStore {
  state: State;
  private readonly listeners = new Set<() => void>();
  private write: StdOutWrite | null = null;

  constructor(now: number = Date.now()) {
    this.state = {
      taskMap: new Map(),
      runningTasks: [],
      totalTasks: 0,
      completedTasks: 0,
      erroredTasks: 0,
      costUsd: 0,
      startedAt: now,
      revision: 0,
    };
  }

  setStdOutWrite(write: StdOutWrite | null): void {
    this.write = write;
  }

  dispatch = (event: EngineEvent): void => {
    if (this.handle(event)) {
      this.state.revision += 1;
      this.notify();
    }
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private emit(entries: LogEntry[]): void {
    if (entries.length === 0 || !this.write) return;
    this.write(entries);
  }

  // Returns true if the dispatch should bump revision and notify subscribers.
  // Streaming chunk events that only mutate the scratchpad return false so
  // Ink doesn't relayout per token.
  private handle(event: EngineEvent): boolean {
    switch (event.kind) {
      case 'task:start':
        return this.onTaskStart(event);
      case 'task:end':
        return this.onTaskEnd(event);
      case 'task:error':
        return this.onTaskError(event);
      case 'task:skip':
        return this.onTaskSkip(event);
      case 'iteration:start':
        return this.onIterationStart(event);
      case 'iteration:end':
        return this.onIterationEnd(event);
      case 'claude:text':
        return this.onClaudeText(event);
      case 'claude:thinking':
        return this.onClaudeThinking(event);
      case 'claude:end':
        return this.onClaudeEnd(event);
      case 'shell:stdout':
        return this.onShellStdout(event);
      case 'shell:stderr':
        return this.onShellStderr(event);
      case 'shell:end':
        return this.onShellEnd(event);
      case 'claude:tool_use':
        return this.onToolUse(event);
      case 'claude:tool_result':
        return this.onToolResult(event);
    }
  }

  private onTaskStart(event: Extract<EngineEvent, { kind: 'task:start' }>): boolean {
    const name = nameOf(event.path);
    const task: RunningTask = {
      taskId: event.taskId,
      name,
      startedAt: Date.now(),
      activityMap: new Map(),
      runningActivities: [],
    };
    this.state.taskMap.set(event.taskId, task);
    this.state.runningTasks.push(task);
    this.state.totalTasks += 1;
    const startEntry: TaskEntry = {
      kind: 'task-start',
      name,
      taskId: event.taskId,
    };
    this.emit([startEntry]);
    return true;
  }

  private onTaskEnd(event: Extract<EngineEvent, { kind: 'task:end' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    // Streams have already drained themselves via claude:end / shell:end.
    this.unregisterTask(task);
    let costUsd: number | null = null;
    let toolsCount: number | null = null;
    if (event.output && typeof event.output === 'object') {
      const out = event.output as Record<string, unknown>;
      const v = out.totalCostUsd;
      if (typeof v === 'number' && Number.isFinite(v)) costUsd = v;
      const tools = out.toolsUsed;
      if (Array.isArray(tools)) toolsCount = tools.length;
    }
    const endEntry: TaskEntry = {
      kind: 'task-end',
      name: task.name,
      taskId: event.taskId,
      durationMs: Math.max(0, Date.now() - task.startedAt),
      costUsd,
      toolsCount,
    };
    this.state.costUsd += costUsd ?? 0;
    this.state.completedTasks += 1;
    this.emit([endEntry]);
    return true;
  }

  private onTaskError(event: Extract<EngineEvent, { kind: 'task:error' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    // Runner crashed mid-stream — drain whatever's in flight before closing.
    this.flushAll(task);
    this.unregisterTask(task);
    const errorEntry: TaskEntry = {
      kind: 'task-error',
      name: task.name,
      taskId: event.taskId,
      message: event.message,
    };
    this.state.erroredTasks += 1;
    this.emit([errorEntry]);
    return true;
  }

  private onTaskSkip(event: Extract<EngineEvent, { kind: 'task:skip' }>): boolean {
    const skipEntry: TaskEntry = {
      kind: 'task-skip',
      name: nameOf(event.path),
      taskId: event.taskId,
    };
    this.emit([skipEntry]);
    return true;
  }

  private onIterationStart(event: Extract<EngineEvent, { kind: 'iteration:start' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    const iterEntry: TaskEntry = {
      kind: 'iteration',
      displayIndex: event.index + 1,
      total: event.total,
    };
    this.emit([iterEntry]);
    return true;
  }

  private onIterationEnd(_event: Extract<EngineEvent, { kind: 'iteration:end' }>): boolean {
    return false;
  }

  private onClaudeEnd(event: Extract<EngineEvent, { kind: 'claude:end' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    this.flushAll(task);
    return true;
  }

  private onShellEnd(event: Extract<EngineEvent, { kind: 'shell:end' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    this.flushAll(task);
    return true;
  }

  private onClaudeText(event: Extract<EngineEvent, { kind: 'claude:text' }>): boolean {
    return this.appendStreamChunk(event.taskId, 'text', event.text);
  }

  private onClaudeThinking(event: Extract<EngineEvent, { kind: 'claude:thinking' }>): boolean {
    return this.appendStreamChunk(event.taskId, 'thinking', event.text);
  }

  private onShellStdout(event: Extract<EngineEvent, { kind: 'shell:stdout' }>): boolean {
    return this.appendStreamChunk(event.taskId, 'shell-stdout', event.chunk);
  }

  private onShellStderr(event: Extract<EngineEvent, { kind: 'shell:stderr' }>): boolean {
    return this.appendStreamChunk(event.taskId, 'shell-stderr', event.chunk);
  }

  // Append a chunk to a stream-kind activity. If an activity of a different
  // stream kind is buffered, flush it first (a cross-kind switch is the
  // natural "this stream is done" signal). Tool activities are untouched.
  private appendStreamChunk(
    taskId: TaskId,
    kind: RunningActivityKindStream,
    chunk: string,
  ): boolean {
    const task = this.state.taskMap.get(taskId);
    if (!task) return false;
    const flushed = this.flushExceptKind(task, kind);
    let activity = task.runningActivities.find((a) => a.kind === kind) as
      | Extract<RunningActivity, { kind: RunningActivityKindStream }>
      | undefined;
    if (!activity) {
      activity = { kind, activityId: nextActivityId(), text: '' };
      task.runningActivities.push(activity);
    }
    activity.text = appendBounded(activity.text, chunk, MAX_TEXT_BUFFER_BYTES);
    return flushed;
  }

  private onToolUse(event: Extract<EngineEvent, { kind: 'claude:tool_use' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    const use: ActivityEntryToolUse = {
      kind: 'tool-use',
      activityId: event.activityId,
      name: event.name,
      input: event.input,
    };
    if (event.name === 'Read') {
      // Coalesce consecutive Reads into a single read-group; a different
      // stream kind already buffered triggers a flush first.
      this.flushExceptKind(task, 'read-group');
      let group = task.runningActivities.find((a) => a.kind === 'read-group') as
        | Extract<RunningActivity, { kind: 'read-group' }>
        | undefined;
      if (!group) {
        group = { kind: 'read-group', uses: [], results: new Map() };
        task.runningActivities.push(group);
      }
      group.uses.push(use);
      task.activityMap.set(event.activityId, group);
    } else {
      // Non-Read tool acts as a terminator for any pending stream-like
      // activity (text/thinking/shell/read-group). Tools coexist freely.
      this.flushExceptKind(task, null);
      const activity: RunningActivity = { kind: 'tool', use };
      task.runningActivities.push(activity);
      task.activityMap.set(event.activityId, activity);
    }
    return true;
  }

  private onToolResult(event: Extract<EngineEvent, { kind: 'claude:tool_result' }>): boolean {
    const task = this.state.taskMap.get(event.taskId);
    if (!task) return false;
    const activity = task.activityMap.get(event.activityId);
    task.activityMap.delete(event.activityId);
    const result: ActivityEntryToolResult = {
      kind: 'tool-result',
      activityId: event.activityId,
      content: truncateString(event.content, MAX_TOOL_RESULT_BYTES),
      isError: event.isError,
    };
    if (activity?.kind === 'read-group') {
      activity.results.set(event.activityId, result);
      return true;
    }
    if (activity?.kind === 'tool') {
      const idx = task.runningActivities.indexOf(activity);
      if (idx >= 0) task.runningActivities.splice(idx, 1);
      this.emit([activity.use, result]);
      return true;
    }
    // Result without a recorded use (shouldn't happen in practice).
    this.emit([result]);
    return true;
  }

  // Emit + remove every non-tool activity except the one matching `keep`
  // (or none if `keep` is null). Tool activities are always preserved
  // (they wait for their result). Returns true if anything was emitted.
  private flushExceptKind(task: RunningTask, keep: RunningActivity['kind'] | null): boolean {
    let flushed = false;
    const next: RunningActivity[] = [];
    for (const a of task.runningActivities) {
      if (a.kind === 'tool' || a.kind === keep) {
        next.push(a);
        continue;
      }
      this.emitActivity(a);
      flushed = true;
    }
    if (flushed) task.runningActivities = next;
    return flushed;
  }

  // Emit + remove everything in the task's activities (used by claude:end /
  // shell:end / task:error). Tools in flight become orphan running rows.
  private flushAll(task: RunningTask): void {
    if (task.runningActivities.length === 0) return;
    const drained = task.runningActivities;
    task.runningActivities = [];
    for (const a of drained) this.emitActivity(a);
  }

  private emitActivity(a: RunningActivity): void {
    if (a.kind === 'read-group') {
      const results = Array.from(a.results.values());
      this.emit([...a.uses, ...results]);
      return;
    }
    if (a.kind === 'tool') {
      // Standalone running tool-use (no matching result arrived).
      this.emit([a.use]);
      return;
    }
    this.emit([{ kind: a.kind, activityId: a.activityId, text: a.text }]);
  }

  private unregisterTask(task: RunningTask): void {
    this.state.taskMap.delete(task.taskId);
    const idx = this.state.runningTasks.indexOf(task);
    if (idx >= 0) this.state.runningTasks.splice(idx, 1);
  }
}
