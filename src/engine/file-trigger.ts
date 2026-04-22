import { existsSync } from 'node:fs';

export interface FileTrigger {
  name: string;
  path: string;
  then: string;
}

export async function watchForFile(
  triggers: ReadonlyArray<FileTrigger>,
  signal?: AbortSignal,
  pollIntervalMs = 50,
): Promise<FileTrigger> {
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    for (const t of triggers) {
      if (existsSync(t.path)) return t;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
