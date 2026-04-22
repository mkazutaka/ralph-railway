export type TaskPath = ReadonlyArray<string>;

export type EngineEvent =
  | { kind: 'task:start'; path: TaskPath; taskKind: string }
  | { kind: 'task:end'; path: TaskPath; taskKind: string; durationMs: number; output?: unknown }
  | { kind: 'task:error'; path: TaskPath; taskKind: string; message: string }
  | { kind: 'iteration:start'; path: TaskPath; index: number; total: number | null }
  | { kind: 'claude:text'; path: TaskPath; text: string }
  | { kind: 'claude:thinking'; path: TaskPath; text: string }
  | {
      kind: 'claude:tool_use';
      path: TaskPath;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'claude:tool_result';
      path: TaskPath;
      toolUseId: string;
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
