import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { ExecutionContext } from '../../src/engine/context';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';
import { registerRunner, type TaskRunner } from '../../src/runners/base';
import { CallDispatcher } from '../../src/runners/call';
import { type CodexClientLike, CodexRunner, type CodexThreadLike } from '../../src/runners/codex';

const fakeCodex = (): CodexClientLike => {
  const thread: CodexThreadLike = {
    id: 'thread-test',
    runStreamed: async (input) => ({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-test' } as never;
        yield {
          type: 'item.completed',
          item: {
            id: 'm1',
            type: 'agent_message',
            text: `mock(${String(input).slice(0, 24)})`,
          },
        } as never;
        yield { type: 'turn.completed', usage: null } as never;
      })(),
    }),
  };
  return {
    startThread: () => thread,
    resumeThread: () => thread,
  };
};

class MockingCallDispatcher implements TaskRunner {
  private readonly real = new CallDispatcher();
  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown> {
    if (body.call === 'codex') {
      return new CodexRunner(fakeCodex).run(ctx, body);
    }
    return this.real.run(ctx, body);
  }
}

beforeEach(() => {
  registerRunner('call', () => new MockingCallDispatcher());
});

afterEach(() => {
  registerRunner('call', () => new CallDispatcher());
});

test('codex workflow runs end-to-end with mocked Codex SDK', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-call-codex.yaml');
  const outputs = await new Engine().runWorkflow(wf, {
    input: { feature: 'search' },
    workDir: '.',
  });

  const implement = outputs.implement as { text: string; finalResponse: string; threadId: string };
  expect(implement).toBeDefined();
  expect(implement.text).toContain('mock(');
  expect(implement.finalResponse).toContain('Implement search');
  expect(implement.threadId).toBe('thread-test');
});
