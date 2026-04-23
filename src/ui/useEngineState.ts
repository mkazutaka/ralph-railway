// src/ui/useEngineState.ts
import { useReducer } from 'react';
import type { EngineEvent, TaskPath } from '../engine/events';

/**
 * One unit emitted to the Static event log. Each entry carries everything the
 * renderer needs (no lookups against state). `depth` is `path.length - 1`,
 * used by the renderer to indent.
 */
export type LogEntry =
  | { kind: 'task-start'; depth: number; name: string; taskKind: string }
  | {
      kind: 'task-end';
      depth: number;
      name: string;
      durationMs: number;
      costUsd: number | null;
      toolsCount: number | null;
    }
  | { kind: 'task-error'; depth: number; name: string; message: string }
  | { kind: 'task-skip'; depth: number; name: string }
  | { kind: 'iteration'; depth: number; displayIndex: number; total: number | null }
  | { kind: 'text'; depth: number; text: string }
  | { kind: 'thinking'; depth: number; text: string }
  | { kind: 'shell-stdout'; depth: number; text: string }
  | { kind: 'shell-stderr'; depth: number; text: string }
  | {
      kind: 'tool-use';
      depth: number;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'tool-result';
      depth: number;
      toolUseId: string;
      name: string;
      content: string;
      isError: boolean;
    };

/**
 * Per-running-task scratchpad. Not exposed to the renderer; used by the
 * reducer to compute durations at task:end and to coalesce streaming text /
 * thinking until the next non-stream event for that task.
 */
interface PendingTask {
  startedAt: number;
  depth: number;
  name: string;
  /** Buffered streaming text, flushed on the next non-text/thinking event. */
  pendingText: string | null;
  pendingThinking: string | null;
  /** Buffered shell stdout/stderr, flushed on the next non-matching event. */
  pendingShellStdout: string | null;
  pendingShellStderr: string | null;
  /** toolUseId → tool name, used to label tool_result entries. */
  toolNamesById: Map<string, string>;
}

export interface State {
  logEntries: LogEntry[];
  /** keyOf(path) for every task currently in the running state, in start order. */
  runningPaths: string[];
  totalTasks: number;
  costUsd: number;
  startedAt: number;
  /** Internal: per-path scratchpad. Not for renderer consumption. */
  pending: Map<string, PendingTask>;
}

export type EngineAction = EngineEvent;

function keyOf(path: TaskPath): string {
  return path.join('>');
}

function nameOf(path: TaskPath): string {
  // Strip the `#N` disambiguation suffix the executor adds for duplicate-name siblings.
  const last = path[path.length - 1] ?? '(root)';
  return last.replace(/#\d+$/, '');
}

function depthOf(path: TaskPath): number {
  return Math.max(0, path.length - 1);
}

export function initialState(now: number = Date.now()): State {
  return {
    logEntries: [],
    runningPaths: [],
    totalTasks: 0,
    costUsd: 0,
    startedAt: now,
    pending: new Map(),
  };
}

/**
 * Flush any buffered streaming text/thinking for `key` into log entries. The
 * pending buffers are cleared on the returned scratchpad. Returns a new
 * `pending` map and the entries to append (in order).
 */
function flushPending(
  pending: Map<string, PendingTask>,
  key: string,
): { pending: Map<string, PendingTask>; entries: LogEntry[] } {
  const p = pending.get(key);
  if (
    !p ||
    (p.pendingText == null &&
      p.pendingThinking == null &&
      p.pendingShellStdout == null &&
      p.pendingShellStderr == null)
  ) {
    return { pending, entries: [] };
  }
  const entries: LogEntry[] = [];
  // Claude text/thinking: by construction at most one is non-null at a time.
  // Shell stdout/stderr: each kind flushes the other when it arrives, so at
  // most one of the two shell buffers is non-null here either.
  if (p.pendingText != null) {
    entries.push({ kind: 'text', depth: p.depth, text: p.pendingText });
  }
  if (p.pendingThinking != null) {
    entries.push({ kind: 'thinking', depth: p.depth, text: p.pendingThinking });
  }
  if (p.pendingShellStdout != null) {
    entries.push({ kind: 'shell-stdout', depth: p.depth, text: p.pendingShellStdout });
  }
  if (p.pendingShellStderr != null) {
    entries.push({ kind: 'shell-stderr', depth: p.depth, text: p.pendingShellStderr });
  }
  const next = new Map(pending);
  next.set(key, {
    ...p,
    pendingText: null,
    pendingThinking: null,
    pendingShellStdout: null,
    pendingShellStderr: null,
  });
  return { pending: next, entries };
}

export function reducer(state: State, event: EngineAction): State {
  switch (event.kind) {
    case 'task:start': {
      const key = keyOf(event.path);
      const depth = depthOf(event.path);
      const name = nameOf(event.path);
      const entry: LogEntry = { kind: 'task-start', depth, name, taskKind: event.taskKind };
      // If this path re-enters while a prior run's buffered text has not yet
      // been flushed (e.g. a for-loop body starting its next iteration without
      // an intervening task:end), flush now so no streaming content is lost.
      const flushed = state.pending.has(key)
        ? flushPending(state.pending, key)
        : { pending: state.pending, entries: [] as LogEntry[] };
      const pending = new Map(flushed.pending);
      pending.set(key, {
        startedAt: Date.now(),
        depth,
        name,
        pendingText: null,
        pendingThinking: null,
        pendingShellStdout: null,
        pendingShellStderr: null,
        toolNamesById: new Map(),
      });
      // Only append the key when it is not already tracked; on re-entry it is
      // already present so we leave runningPaths unchanged (no duplicates).
      const runningPaths = state.runningPaths.includes(key)
        ? state.runningPaths
        : [...state.runningPaths, key];
      return {
        ...state,
        logEntries: [...state.logEntries, ...flushed.entries, entry],
        pending,
        runningPaths,
        totalTasks: state.totalTasks + 1,
      };
    }

    case 'task:end': {
      const key = keyOf(event.path);
      const flushed = flushPending(state.pending, key);
      const p = flushed.pending.get(key);
      const startedAt = p?.startedAt ?? Date.now();
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.name ?? nameOf(event.path);
      let costUsd: number | null = null;
      let toolsCount: number | null = null;
      if (event.output && typeof event.output === 'object') {
        const out = event.output as Record<string, unknown>;
        const v = out.totalCostUsd;
        if (typeof v === 'number' && Number.isFinite(v)) costUsd = v;
        const tools = out.toolsUsed;
        if (Array.isArray(tools)) toolsCount = tools.length;
      }
      const entry: LogEntry = {
        kind: 'task-end',
        depth,
        name,
        durationMs: Math.max(0, Date.now() - startedAt),
        costUsd,
        toolsCount,
      };
      const pending = new Map(flushed.pending);
      pending.delete(key);
      return {
        ...state,
        logEntries: [...state.logEntries, ...flushed.entries, entry],
        pending,
        runningPaths: state.runningPaths.filter((k) => k !== key),
        costUsd: state.costUsd + (costUsd ?? 0),
      };
    }

    case 'task:error': {
      const key = keyOf(event.path);
      const flushed = flushPending(state.pending, key);
      const p = flushed.pending.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.name ?? nameOf(event.path);
      const entry: LogEntry = { kind: 'task-error', depth, name, message: event.message };
      const pending = new Map(flushed.pending);
      pending.delete(key);
      return {
        ...state,
        logEntries: [...state.logEntries, ...flushed.entries, entry],
        pending,
        runningPaths: state.runningPaths.filter((k) => k !== key),
      };
    }

    case 'task:skip': {
      // Skipped tasks never emit task:start, so there's no pending row to
      // flush or running path to remove. Just append a single "skipped" entry.
      const depth = depthOf(event.path);
      const name = nameOf(event.path);
      const entry: LogEntry = { kind: 'task-skip', depth, name };
      return {
        ...state,
        logEntries: [...state.logEntries, entry],
      };
    }

    case 'iteration:start': {
      const key = keyOf(event.path);
      const flushed = flushPending(state.pending, key);
      const depth = flushed.pending.get(key)?.depth ?? depthOf(event.path);
      const entry: LogEntry = {
        kind: 'iteration',
        depth,
        displayIndex: event.index + 1,
        total: event.total,
      };
      return {
        ...state,
        logEntries: [...state.logEntries, ...flushed.entries, entry],
        pending: flushed.pending,
      };
    }

    case 'claude:text': {
      const key = keyOf(event.path);
      const pending = new Map(state.pending);
      const p = pending.get(key);
      if (!p) return state;
      let logEntries = state.logEntries;
      if (p.pendingThinking != null) {
        logEntries = [...logEntries, { kind: 'thinking', depth: p.depth, text: p.pendingThinking }];
      }
      pending.set(key, {
        ...p,
        pendingText: (p.pendingText ?? '') + event.text,
        pendingThinking: null,
      });
      return { ...state, logEntries, pending };
    }

    case 'claude:thinking': {
      const key = keyOf(event.path);
      const pending = new Map(state.pending);
      const p = pending.get(key);
      if (!p) return state;
      let logEntries = state.logEntries;
      if (p.pendingText != null) {
        logEntries = [...logEntries, { kind: 'text', depth: p.depth, text: p.pendingText }];
      }
      pending.set(key, {
        ...p,
        pendingThinking: (p.pendingThinking ?? '') + event.text,
        pendingText: null,
      });
      return { ...state, logEntries, pending };
    }

    case 'shell:stdout': {
      const key = keyOf(event.path);
      const pending = new Map(state.pending);
      const p = pending.get(key);
      if (!p) return state;
      let logEntries = state.logEntries;
      if (p.pendingShellStderr != null) {
        logEntries = [
          ...logEntries,
          { kind: 'shell-stderr', depth: p.depth, text: p.pendingShellStderr },
        ];
      }
      pending.set(key, {
        ...p,
        pendingShellStdout: (p.pendingShellStdout ?? '') + event.chunk,
        pendingShellStderr: null,
      });
      return { ...state, logEntries, pending };
    }

    case 'shell:stderr': {
      const key = keyOf(event.path);
      const pending = new Map(state.pending);
      const p = pending.get(key);
      if (!p) return state;
      let logEntries = state.logEntries;
      if (p.pendingShellStdout != null) {
        logEntries = [
          ...logEntries,
          { kind: 'shell-stdout', depth: p.depth, text: p.pendingShellStdout },
        ];
      }
      pending.set(key, {
        ...p,
        pendingShellStderr: (p.pendingShellStderr ?? '') + event.chunk,
        pendingShellStdout: null,
      });
      return { ...state, logEntries, pending };
    }

    case 'claude:tool_use': {
      const key = keyOf(event.path);
      const flushed = flushPending(state.pending, key);
      const p = flushed.pending.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const entry: LogEntry = {
        kind: 'tool-use',
        depth,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      };
      const pending = new Map(flushed.pending);
      if (p) {
        const toolNamesById = new Map(p.toolNamesById);
        toolNamesById.set(event.toolUseId, event.name);
        pending.set(key, { ...p, toolNamesById });
      }
      return {
        ...state,
        logEntries: [...state.logEntries, ...flushed.entries, entry],
        pending,
      };
    }

    case 'claude:tool_result': {
      const key = keyOf(event.path);
      const flushed = flushPending(state.pending, key);
      const p = flushed.pending.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.toolNamesById.get(event.toolUseId) ?? '?';
      const entry: LogEntry = {
        kind: 'tool-result',
        depth,
        toolUseId: event.toolUseId,
        name,
        content: event.content,
        isError: event.isError,
      };
      return {
        ...state,
        logEntries: [...state.logEntries, ...flushed.entries, entry],
        pending: flushed.pending,
      };
    }
  }
}

export function useEngineState(): {
  state: State;
  dispatch: (event: EngineAction) => void;
} {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());
  return { state, dispatch };
}
