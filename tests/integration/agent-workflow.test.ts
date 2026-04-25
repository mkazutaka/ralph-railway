import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { ExecutionContext } from '../../src/engine/context';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';
import { registerRunner, type TaskRunner } from '../../src/runners/base';
import { CallDispatcher } from '../../src/runners/call';
import { ClaudeRunner, type QueryFn } from '../../src/runners/claude';

const fakeQuery = (({ prompt }: { prompt: string }) => {
  return (async function* () {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: `mock(${String(prompt).slice(0, 24)})` }],
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      duration_ms: 5,
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
    };
  })();
}) as unknown as QueryFn;

class MockingCallDispatcher implements TaskRunner {
  private readonly real = new CallDispatcher();
  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown> {
    if (body.call === 'claude') {
      return new ClaudeRunner(fakeQuery).run(ctx, body);
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

test('agent workflow runs end-to-end with mocked Claude', async () => {
  const wf = loadWorkflow('tests/fixtures/dsl-call-claude.yaml');
  const outputs = await new Engine().runWorkflow(wf, {
    input: { modules: ['a', 'b'] },
    workDir: '.',
  });

  // The for-loop's `iterScope` shares the outputs map with the parent, so the
  // last iteration's `generate` output is the one that survives ("last write
  // wins" semantics).
  const generate = outputs.generate as { text: string };
  expect(generate).toBeDefined();
  expect(generate.text).toContain('mock(');
  expect(generate.text).toContain('Generate module b');

  const review = outputs.phase2_review as { text: string };
  expect(review).toBeDefined();
  expect(review.text).toContain('mock(');
  expect(review.text).toContain('Review modules');
});
