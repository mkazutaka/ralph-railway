// src/ui/useEngineState.ts
import { useCallback, useReducer, useRef } from 'react';
import type { EngineEvent, TaskPath } from '../engine/events';

/**
 * Memory caps. Without these the reducer could retain GBs of streamed Claude
 * text / tool-result payloads on long workflows and OOM the V8 heap.
 *
 * - `MAX_TOOL_RESULT_BYTES`: per-result cap applied at insert time. Tool
 *   results (file reads, command output, etc.) are the largest single strings
 *   we observe in the wild — truncate head + tail.
 * - `MAX_TEXT_BUFFER_BYTES`: per-task accumulating buffer cap for streaming
 *   `claude:text` / `claude:thinking` / `shell:stdout` / `shell:stderr`.
 *   Without this a single multi-MB Claude response grows unbounded between
 *   flushes.
 * - `LIVE_WINDOW`: entries older than this many positions from the tail have
 *   their large content fields stripped to free heap. The entries themselves
 *   stay in the array so `<Static>`'s `items.slice(index)` indexing remains
 *   correct (Ink already drew them to the terminal — modifying the buffer
 *   doesn't affect what's on screen).
 * - `STUB_INTERVAL`: amortize the stubbing pass — only run it once per this
 *   many newly-out-of-window entries.
 */
const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_TEXT_BUFFER_BYTES = 64 * 1024;
const LIVE_WINDOW = 2000;
const STUB_INTERVAL = 256;

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
  /**
   * Bumped on every state-changing reducer call. Acts as the dependency for
   * `useMemo` consumers that read mutated arrays/maps in place — the array
   * reference itself no longer changes per dispatch, so callers must depend
   * on `revision` to detect updates.
   */
  revision: number;
  /** Index up to which `logEntries[i].content/text/input` have been stubbed. */
  stubbedThrough: number;
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

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.max(64, Math.floor((max - 64) / 2));
  return `${s.slice(0, half)}\n... [${s.length - max} chars truncated] ...\n${s.slice(s.length - half)}`;
}

function appendBounded(buf: string | null, chunk: string, max: number): string {
  const next = (buf ?? '') + chunk;
  return next.length > max ? truncateString(next, max) : next;
}

/**
 * Free the large fields of an old entry so streaming workflows don't retain
 * GBs of historical payload. Ink's `<Static>` has already drawn the row, so
 * mutating the in-memory copy has no visual effect — only heap is reclaimed.
 */
function stubEntryContent(e: LogEntry): void {
  switch (e.kind) {
    case 'text':
    case 'thinking':
    case 'shell-stdout':
    case 'shell-stderr':
      if (e.text.length > 0) (e as { text: string }).text = '';
      break;
    case 'tool-use':
      // Replace the input object so retained closures over it can be GC'd.
      if (Object.keys(e.input).length > 0) (e as { input: Record<string, unknown> }).input = {};
      break;
    case 'tool-result':
      if (e.content.length > 0) (e as { content: string }).content = '';
      break;
    default:
      // task-start, task-end, task-error, task-skip, iteration carry only
      // small primitives — nothing to free.
      break;
  }
}

function maybeStub(state: State): void {
  const target = Math.max(0, state.logEntries.length - LIVE_WINDOW);
  if (target - state.stubbedThrough < STUB_INTERVAL) return;
  for (let i = state.stubbedThrough; i < target; i++) {
    const e = state.logEntries[i];
    if (e) stubEntryContent(e);
  }
  state.stubbedThrough = target;
}

export function initialState(now: number = Date.now()): State {
  return {
    logEntries: [],
    runningPaths: [],
    totalTasks: 0,
    costUsd: 0,
    startedAt: now,
    pending: new Map(),
    revision: 0,
    stubbedThrough: 0,
  };
}

/**
 * Flush any buffered streaming text/thinking/shell for `key` directly into
 * `state.logEntries`. The pending fields on the scratchpad are nulled in
 * place. Returns nothing — the reducer reads `state.logEntries` after.
 */
function flushPendingInto(state: State, key: string): void {
  const p = state.pending.get(key);
  if (
    !p ||
    (p.pendingText == null &&
      p.pendingThinking == null &&
      p.pendingShellStdout == null &&
      p.pendingShellStderr == null)
  ) {
    return;
  }
  // Claude text/thinking: by construction at most one is non-null at a time.
  // Shell stdout/stderr: each kind flushes the other when it arrives, so at
  // most one of the two shell buffers is non-null here either.
  if (p.pendingText != null) {
    state.logEntries.push({ kind: 'text', depth: p.depth, text: p.pendingText });
    p.pendingText = null;
  }
  if (p.pendingThinking != null) {
    state.logEntries.push({ kind: 'thinking', depth: p.depth, text: p.pendingThinking });
    p.pendingThinking = null;
  }
  if (p.pendingShellStdout != null) {
    state.logEntries.push({
      kind: 'shell-stdout',
      depth: p.depth,
      text: p.pendingShellStdout,
    });
    p.pendingShellStdout = null;
  }
  if (p.pendingShellStderr != null) {
    state.logEntries.push({
      kind: 'shell-stderr',
      depth: p.depth,
      text: p.pendingShellStderr,
    });
    p.pendingShellStderr = null;
  }
}

function bump(state: State): State {
  state.revision += 1;
  maybeStub(state);
  return state;
}

/**
 * Mutating reducer. Inner collections (`logEntries`, `runningPaths`,
 * `pending`) are mutated in place; the same `state` reference is returned.
 * Re-render is driven by `state.revision`, which `useMemo` consumers must
 * include in their dependency list.
 *
 * Why mutate: the previous immutable approach spread `[...state.logEntries,
 * ...]` and `new Map(state.pending)` on every event, producing O(N²) work
 * and allocations across N events — the dominant contributor to OOMs on
 * long workflows. Mutation drops this to O(1) per event.
 */
export function reducer(state: State, event: EngineAction): State {
  switch (event.kind) {
    case 'task:start': {
      const key = keyOf(event.path);
      const depth = depthOf(event.path);
      const name = nameOf(event.path);
      // If this path re-enters while a prior run's buffered text has not yet
      // been flushed (e.g. a for-loop body starting its next iteration without
      // an intervening task:end), flush now so no streaming content is lost.
      if (state.pending.has(key)) flushPendingInto(state, key);
      state.logEntries.push({ kind: 'task-start', depth, name, taskKind: event.taskKind });
      state.pending.set(key, {
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
      if (!state.runningPaths.includes(key)) state.runningPaths.push(key);
      state.totalTasks += 1;
      return bump(state);
    }

    case 'task:end': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const p = state.pending.get(key);
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
      state.logEntries.push({
        kind: 'task-end',
        depth,
        name,
        durationMs: Math.max(0, Date.now() - startedAt),
        costUsd,
        toolsCount,
      });
      state.pending.delete(key);
      const idx = state.runningPaths.indexOf(key);
      if (idx >= 0) state.runningPaths.splice(idx, 1);
      state.costUsd += costUsd ?? 0;
      return bump(state);
    }

    case 'task:error': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const p = state.pending.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.name ?? nameOf(event.path);
      state.logEntries.push({ kind: 'task-error', depth, name, message: event.message });
      state.pending.delete(key);
      const idx = state.runningPaths.indexOf(key);
      if (idx >= 0) state.runningPaths.splice(idx, 1);
      return bump(state);
    }

    case 'task:skip': {
      // Skipped tasks never emit task:start, so there's no pending row to
      // flush or running path to remove. Just append a single "skipped" entry.
      state.logEntries.push({
        kind: 'task-skip',
        depth: depthOf(event.path),
        name: nameOf(event.path),
      });
      return bump(state);
    }

    case 'iteration:start': {
      const key = keyOf(event.path);
      flushPendingInto(state, key);
      const depth = state.pending.get(key)?.depth ?? depthOf(event.path);
      state.logEntries.push({
        kind: 'iteration',
        depth,
        displayIndex: event.index + 1,
        total: event.total,
      });
      return bump(state);
    }

    case 'claude:text': {
      const key = keyOf(event.path);
      const p = state.pending.get(key);
      if (!p) return state;
      if (p.pendingThinking != null) {
        state.logEntries.push({ kind: 'thinking', depth: p.depth, text: p.pendingThinking });
        p.pendingThinking = null;
      }
      p.pendingText = appendBounded(p.pendingText, event.text, MAX_TEXT_BUFFER_BYTES);
      return bump(state);
    }

    case 'claude:thinking': {
      const key = keyOf(event.path);
      const p = state.pending.get(key);
      if (!p) return state;
      if (p.pendingText != null) {
        state.logEntries.push({ kind: 'text', depth: p.depth, text: p.pendingText });
        p.pendingText = null;
      }
      p.pendingThinking = appendBounded(p.pendingThinking, event.text, MAX_TEXT_BUFFER_BYTES);
      return bump(state);
    }

    case 'shell:stdout': {
      const key = keyOf(event.path);
      const p = state.pending.get(key);
      if (!p) return state;
      if (p.pendingShellStderr != null) {
        state.logEntries.push({
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
      const p = state.pending.get(key);
      if (!p) return state;
      if (p.pendingShellStdout != null) {
        state.logEntries.push({
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
      const p = state.pending.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      state.logEntries.push({
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
      const p = state.pending.get(key);
      const depth = p?.depth ?? depthOf(event.path);
      const name = p?.toolNamesById.get(event.toolUseId) ?? '?';
      state.logEntries.push({
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
 * Hook wrapper around the mutating `reducer`. Held in `useRef` so React's
 * StrictMode double-invocation of `useReducer` reducers can't corrupt the
 * mutable state. Re-render is forced via a separate counter when `revision`
 * advances.
 */
export function useEngineState(): {
  state: State;
  dispatch: (event: EngineAction) => void;
} {
  const stateRef = useRef<State | null>(null);
  if (stateRef.current === null) stateRef.current = initialState();
  const [, force] = useReducer((x: number) => x + 1, 0);
  const dispatch = useCallback((event: EngineAction) => {
    const s = stateRef.current;
    if (s === null) return;
    const before = s.revision;
    reducer(s, event);
    if (s.revision !== before) force();
  }, []);
  return { state: stateRef.current, dispatch };
}
