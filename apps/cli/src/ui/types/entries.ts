import type { ActivityId, TaskId } from './ids';

// Lifecycle entries emitted by ralph's executor for each YAML task instance.
// Pairing is by `taskId`; the executor mints a fresh id per `runTask` call so
// loop re-entries with the same path don't collide.
export interface TaskEntryTaskStart {
  kind: 'task-start';
  name: string;
  taskId: TaskId;
}

export interface TaskEntryTaskEnd {
  kind: 'task-end';
  name: string;
  taskId: TaskId;
  durationMs: number;
  costUsd: number | null;
  toolsCount: number | null;
}

export interface TaskEntryTaskError {
  kind: 'task-error';
  name: string;
  taskId: TaskId;
  message: string;
}

export interface TaskEntryTaskSkip {
  kind: 'task-skip';
  name: string;
  taskId: TaskId;
}

export interface TaskEntryIteration {
  kind: 'iteration';
  displayIndex: number;
  total: number | null;
}

export type TaskEntry =
  | TaskEntryTaskStart
  | TaskEntryTaskEnd
  | TaskEntryTaskError
  | TaskEntryTaskSkip
  | TaskEntryIteration;

// Activity entries: content streamed inside a task (claude text/tool calls
// or shell stdio). `activityId` is unique per entry; for tool-use/tool-result
// it doubles as the pair-link (both share the same id).
export interface ActivityEntryText {
  kind: 'text';
  activityId: ActivityId;
  text: string;
}

export interface ActivityEntryThinking {
  kind: 'thinking';
  activityId: ActivityId;
  text: string;
}

export interface ActivityEntryShellStdout {
  kind: 'shell-stdout';
  activityId: ActivityId;
  text: string;
}

export interface ActivityEntryShellStderr {
  kind: 'shell-stderr';
  activityId: ActivityId;
  text: string;
}

export interface ActivityEntryToolUse {
  kind: 'tool-use';
  activityId: ActivityId;
  name: string;
  input: Record<string, unknown>;
}

export interface ActivityEntryToolResult {
  kind: 'tool-result';
  activityId: ActivityId;
  content: string;
  isError: boolean;
}

export type ActivityEntry =
  | ActivityEntryText
  | ActivityEntryThinking
  | ActivityEntryShellStdout
  | ActivityEntryShellStderr
  | ActivityEntryToolUse
  | ActivityEntryToolResult;

export type LogEntry = TaskEntry | ActivityEntry;
