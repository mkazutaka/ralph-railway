export type TaskPath = ReadonlyArray<string>;

export type EngineEvent =
  | { kind: 'task:start'; path: TaskPath; taskKind: string; taskId: string }
  | {
      kind: 'task:end';
      path: TaskPath;
      taskKind: string;
      taskId: string;
      durationMs: number;
      output?: unknown;
    }
  | {
      kind: 'task:error';
      path: TaskPath;
      taskKind: string;
      taskId: string;
      message: string;
    }
  | { kind: 'task:skip'; path: TaskPath; taskKind: string; taskId: string }
  | {
      kind: 'iteration:start';
      path: TaskPath;
      taskId: string;
      index: number;
      total: number | null;
    }
  | {
      kind: 'iteration:end';
      path: TaskPath;
      taskId: string;
      index: number;
      total: number | null;
    }
  | { kind: 'claude:text'; path: TaskPath; taskId: string; text: string }
  | { kind: 'claude:thinking'; path: TaskPath; taskId: string; text: string }
  | { kind: 'claude:end'; path: TaskPath; taskId: string }
  | { kind: 'shell:stdout'; path: TaskPath; taskId: string; chunk: string }
  | { kind: 'shell:stderr'; path: TaskPath; taskId: string; chunk: string }
  | { kind: 'shell:end'; path: TaskPath; taskId: string }
  | {
      kind: 'claude:tool_use';
      path: TaskPath;
      taskId: string;
      activityId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'claude:tool_result';
      path: TaskPath;
      taskId: string;
      activityId: string;
      content: string;
      isError: boolean;
    };

export type EngineListener = (event: EngineEvent) => void;

export class EngineBus {
  private listeners: EngineListener[] = [];

  on(l: EngineListener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
  }
}
