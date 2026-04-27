import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { ExecutionContext } from '../../src/engine/context';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';
import { registerRunner, type TaskRunner } from '../../src/runners/base';
import { CallDispatcher } from '../../src/runners/call';
import { ClaudeRunner } from '../../src/runners/claude';
import {
  assistantMessage,
  createStrictQuery,
  resultMessage,
  textBlock,
} from '../helpers/strict-claude-sdk';

const fakeQuery = createStrictQuery(({ prompt }) => {
  return (async function* () {
    yield assistantMessage([textBlock(`mock(${String(prompt).slice(0, 24)})`)]);
    yield resultMessage({ duration_ms: 5, total_cost_usd: 0 });
  })();
});

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

const errorQuery = createStrictQuery(() => {
  return (async function* () {
    yield assistantMessage([textBlock('partial')]);
    yield resultMessage({
      subtype: 'error_during_execution',
      duration_ms: 5,
      is_error: true,
      total_cost_usd: 0,
    });
  })();
});

class ErrorMockingCallDispatcher implements TaskRunner {
  private readonly real = new CallDispatcher();
  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown> {
    if (body.call === 'claude') {
      return new ClaudeRunner(errorQuery).run(ctx, body);
    }
    return this.real.run(ctx, body);
  }
}

test('claude is_error: true surfaces as outputs.<task>.isError === true', async () => {
  registerRunner('call', () => new ErrorMockingCallDispatcher());
  try {
    const wf = loadWorkflow('tests/fixtures/dsl-call-claude.yaml');
    const outputs = await new Engine().runWorkflow(wf, {
      input: { modules: ['x'] },
      workDir: '.',
    });
    const generate = outputs.generate as { isError: boolean; text: string };
    expect(generate).toBeDefined();
    expect(generate.isError).toBe(true);
    expect(generate.text).toContain('partial');
  } finally {
    registerRunner('call', () => new CallDispatcher());
  }
});
