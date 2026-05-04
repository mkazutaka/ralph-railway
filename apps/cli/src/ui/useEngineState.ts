// src/ui/useEngineState.ts
import { useEffect, useReducer } from 'react';
import type { EngineEvent, TaskPath } from '../engine/events';

const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_TEXT_BUFFER_BYTES = 64 * 1024;

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
 * Per-running-task scratchpad. Used by the reducer to compute durations at
 * task:end and to coalesce streaming text/thinking/shell chunks until the next
 * non-stream event for that task.
 */
interface PendingTask {
  startedAt: number;
  depth: number;
  name: string;
  pendingText: string | null;
  pendingThinking: string | null;
  pendingShellStdout: string | null;
  pendingShellStderr: string | null;
  /** toolUseId → tool name, used to label tool-result entries. */
  toolNamesById: Map<string, string>;
}

export interface State {
  /**
   * Uncommitted LogEntry buffer. After every dispatch the EngineStore runs
   * `splitAtLiveBoundary` and splices the committable prefix out — so this
   * stays bounded by in-flight tool calls (typically a handful), regardless
   * of total workflow length.
   */
  pending: LogEntry[];
  /** Per-running-task scratchpad. Not for renderer consumption. */
  pendingByPath: Map<string, PendingTask>;
  /** keyOf(path) for tasks currently in the running state, in start order. */
  runningPaths: string[];
  totalTasks: number;
  completedTasks: number;
  erroredTasks: number;
  costUsd: number;
  startedAt: number;
  /** Bumped on every state-changing reducer call; subscribers re-render on change. */
  revision: number;
}

export type EngineAction = EngineEvent;

export function keyOf(path: TaskPath): string {
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

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.max(64, Math.floor((max - 64) / 2));
  return `${s.slice(0, half)}\n... [${s.length - max} chars truncated] ...\n${s.slice(s.length - half)}`;
}

function appendBounded(buf: string | null, chunk: string, max: number): string {
  const next = (buf ?? '') + chunk;
  return next.length > max ? truncateString(next, max) : next;
}

export function initialState(now: number = Date.now()): State {
  return {
    pending: [],
    pendingByPath: new Map(),
    runningPaths: [],
    totalTasks: 0,
    completedTasks: 0,
    erroredTasks: 0,
    costUsd: 0,
    startedAt: now,
    revision: 0,
  };
}

/**
 * Flush any buffered streaming text/thinking/shell for `key` directly into
 * `state.pending`. The pending fields on the scratchpad are nulled in place.
 */
function flushPendingInto(state: State, key: string): void {
  const p = state.pendingByPath.get(key);
  if (
    !p ||
    (p.pendingText == null &&
      p.pendingThinking == null &&
      p.pendingShellStdout == null &&
      p.pendingShellStderr == null)
  ) {
    return;
  }
  if (p.pendingText != null) {
    state.pending.push({ kind: 'text', depth: p.depth, text: p.pendingText });
    p.pendingText = null;
  }
  if (p.pendingThinking != null) {
    state.pending.push({ kind: 'thinking', depth: p.depth, text: p.pendingThinking });
    p.pendingThinking = null;
  }
  if (p.pendingShellStdout != null) {
    state.pending.push({ kind: 'shell-stdout', depth: p.depth, text: p.pendingShellStdout });
    p.pendingShellStdout = null;
  }
  if (p.pendingShellStderr != null) {
    state.pending.push({ kind: 'shell-stderr', depth: p.depth, text: p.pendingShellStderr });
    p.pendingShellStderr = null;
  }
}

function bump(state: State): State {
  state.revision += 1;
  return state;
}

/**
 * Mutating reducer. Inner collections (`pending`, `runningPaths`,
 * `pendingByPath`) are mutated in place; the same `state` reference is
 * returned. Re-render is driven by `state.revision`.
 */
export function reducer(state: State, event: EngineAction): State {
  switch (event.kind) {
    case 'task:start': {
      const key = keyOf(event.path);
      const depth = depthOf(event.path);
      const name = nameOf(event.path);
      // Re-entry without an intervening task:end (e.g. a for-loop body
      // restarting) — flush any buffered streaming content first so it isn't
      // lost across the boundary.
      if (state.pendingByPath.has(key)) flushPendingInto(state, key);
      state.pending.push({ kind: 'task-start', depth, name, taskKind: event.taskKind });
      state.pendingByPath.set(key, {
        startedAt: Date.now(),
        depth,
        name,
        pendingText: null,
        pendingThinking: null,
        pendingShellStdout: null,
        pendingShellStderr: null,
        toolNamesById: new Map(),
      });
      if (!state.runningPaths.includes(key)) state.runningPaths.push(key);
      state.totalTasks += 1;
      return bump(state);
    }

    case 'task:end': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const p = state.pendingByPath.get(key);
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
      state.pending.push({
        kind: 'task-end',
        depth,
        name,
        durationMs: Math.max(0, Date.now() - startedAt),
        costUsd,
        toolsCount,
      });
      state.pendingByPath.delete(key);
      const idx = state.runningPaths.indexOf(key);
      if (idx >= 0) state.runningPaths.splice(idx, 1);
      state.costUsd += costUsd ?? 0;
      state.completedTasks += 1;
      return bump(state);
    }

    case 'task:error': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const p = state.pendingByPath.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.name ?? nameOf(event.path);
      state.pending.push({ kind: 'task-error', depth, name, message: event.message });
      state.pendingByPath.delete(key);
      const idx = state.runningPaths.indexOf(key);
      if (idx >= 0) state.runningPaths.splice(idx, 1);
      state.erroredTasks += 1;
      return bump(state);
    }

    case 'task:skip': {
      state.pending.push({
        kind: 'task-skip',
        depth: depthOf(event.path),
        name: nameOf(event.path),
      });
      return bump(state);
    }

    case 'iteration:start': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const depth = state.pendingByPath.get(key)?.depth ?? depthOf(event.path);
      state.pending.push({
        kind: 'iteration',
        depth,
        displayIndex: event.index + 1,
        total: event.total,
      });
      return bump(state);
    }

    case 'claude:text': {
      const key = keyOf(event.path);
      const p = state.pendingByPath.get(key);
      if (!p) return state;
      if (p.pendingThinking != null) {
        state.pending.push({ kind: 'thinking', depth: p.depth, text: p.pendingThinking });
        p.pendingThinking = null;
      }
      p.pendingText = appendBounded(p.pendingText, event.text, MAX_TEXT_BUFFER_BYTES);
      return bump(state);
    }

    case 'claude:thinking': {
      const key = keyOf(event.path);
      const p = state.pendingByPath.get(key);
      if (!p) return state;
      if (p.pendingText != null) {
        state.pending.push({ kind: 'text', depth: p.depth, text: p.pendingText });
        p.pendingText = null;
      }
      p.pendingThinking = appendBounded(p.pendingThinking, event.text, MAX_TEXT_BUFFER_BYTES);
      return bump(state);
    }

    case 'shell:stdout': {
      const key = keyOf(event.path);
      const p = state.pendingByPath.get(key);
      if (!p) return state;
      if (p.pendingShellStderr != null) {
        state.pending.push({
          kind: 'shell-stderr',
          depth: p.depth,
          text: p.pendingShellStderr,
        });
        p.pendingShellStderr = null;
      }
      p.pendingShellStdout = appendBounded(
        p.pendingShellStdout,
        event.chunk,
        MAX_TEXT_BUFFER_BYTES,
      );
      return bump(state);
    }

    case 'shell:stderr': {
      const key = keyOf(event.path);
      const p = state.pendingByPath.get(key);
      if (!p) return state;
      if (p.pendingShellStdout != null) {
        state.pending.push({
          kind: 'shell-stdout',
          depth: p.depth,
          text: p.pendingShellStdout,
        });
        p.pendingShellStdout = null;
      }
      p.pendingShellStderr = appendBounded(
        p.pendingShellStderr,
        event.chunk,
        MAX_TEXT_BUFFER_BYTES,
      );
      return bump(state);
    }

    case 'claude:tool_use': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const p = state.pendingByPath.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      state.pending.push({
        kind: 'tool-use',
        depth,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      });
      if (p) p.toolNamesById.set(event.toolUseId, event.name);
      return bump(state);
    }

    case 'claude:tool_result': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const p = state.pendingByPath.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.toolNamesById.get(event.toolUseId) ?? '?';
      state.pending.push({
        kind: 'tool-result',
        depth,
        toolUseId: event.toolUseId,
        name,
        content: truncateString(event.content, MAX_TOOL_RESULT_BYTES),
        isError: event.isError,
      });
      return bump(state);
    }
  }
}

/**
 * Out-of-React state container. Owns `pending` and is responsible for
 * committing its settled prefix to scrollback on every dispatch — so the
 * buffer stays bounded by in-flight items, and memory does not grow with
 * workflow length.
 *
 * Why outside React: `<Static>` would retain every RenderItem forever
 * (breaks 1M-event workflows), and rendering inside `useEffect` re-enters
 * Ink's shared react-reconciler and triggers yoga WASM crashes. Doing it
 * here — synchronously inside dispatch, after the reducer settles but
 * before notifying React — sidesteps both.
 */
export class EngineStore {
  state: State;
  private readonly listeners = new Set<() => void>();
  private commitFn: () => void = () => {};

  constructor(now: number = Date.now()) {
    this.state = initialState(now);
  }

  /**
   * Wire the function that flushes the committable prefix to scrollback.
   * Provided by `App.tsx` on mount so it can use Ink's coordinated stdout
   * writer (`useStdout().write`) which keeps log-update's accounting intact.
   * Defaults to a no-op so events that arrive before mount stay buffered
   * and get flushed by the first dispatch after wiring.
   */
  setCommitFn(commit: () => void): void {
    this.commitFn = commit;
  }

  dispatch = (event: EngineAction): void => {
    const before = this.state.revision;
    reducer(this.state, event);
    if (this.state.revision === before) return;
    this.commitFn();
    this.notify();
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
}

/** React subscription hook for an `EngineStore`. */
export function useEngineStore(store: EngineStore): State {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(force), [store]);
  return store.state;
}
