/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { ClaudeRunner, type QueryFn } from '../../src/runners/claude';
import {
  assistantMessage,
  createStrictQuery,
  resultMessage,
  textBlock,
  toolUseBlock,
  userToolResultMessage,
} from '../helpers/strict-claude-sdk';

interface Captured {
  prompt: string | unknown;
  options: any;
}

function makeFakeQuery(opts: {
  text?: string;
  tools?: string[];
  result?: Record<string, unknown> | null;
  capture?: Captured[];
  hold?: () => Promise<void>;
}): QueryFn {
  return createStrictQuery(({ prompt, options }) => {
    opts.capture?.push({ prompt, options });
    return (async function* () {
      if (opts.hold) await opts.hold();
      const blocks: Parameters<typeof assistantMessage>[0] = [];
      if (opts.text != null) blocks.push(textBlock(opts.text));
      for (const name of opts.tools ?? []) {
        blocks.push(toolUseBlock(`tool-${name}`, name));
      }
      yield assistantMessage(blocks);
      if (opts.result !== null) {
        yield resultMessage({ ...(opts.result ?? {}) });
      }
    })();
  });
}

test('returns concatenated assistant text', async () => {
  const fake = makeFakeQuery({ text: 'hello world' });
  const ctx = new ExecutionContext({});
  const out = await new ClaudeRunner(fake).run(ctx, { call: 'claude', with: { prompt: 'hi' } });
  expect(out.text).toBe('hello world');
  expect(out.toolsUsed).toEqual([]);
});

test('collects tool_use names in order', async () => {
  const fake = makeFakeQuery({ text: 'ok', tools: ['Read', 'Edit', 'Bash'] });
  const ctx = new ExecutionContext({});
  const out = await new ClaudeRunner(fake).run(ctx, { call: 'claude', with: { prompt: 'go' } });
  expect(out.toolsUsed).toEqual(['Read', 'Edit', 'Bash']);
});

test('forwards ResultMessage fields', async () => {
  const fake = makeFakeQuery({
    text: 'done',
    result: {
      stop_reason: 'max_turns',
      num_turns: 7,
      duration_ms: 1234,
      total_cost_usd: 0.42,
      is_error: true,
    },
  });
  const ctx = new ExecutionContext({});
  const out = await new ClaudeRunner(fake).run(ctx, { call: 'claude', with: { prompt: 'p' } });
  expect(out.stopReason).toBe('max_turns');
  expect(out.numTurns).toBe(7);
  expect(out.durationMs).toBe(1234);
  expect(out.totalCostUsd).toBe(0.42);
  expect(out.isError).toBe(true);
});

test('throws when prompt is missing', async () => {
  const fake = makeFakeQuery({ text: 'x' });
  const ctx = new ExecutionContext({});
  await expect(new ClaudeRunner(fake).run(ctx, { call: 'claude', with: {} })).rejects.toThrow(
    /requires with.prompt/,
  );
});

test('snake_case YAML keys map to camelCase SDK options', async () => {
  const captured: Captured[] = [];
  const fake = makeFakeQuery({ text: '', capture: captured });
  const ctx = new ExecutionContext({}, undefined, undefined);
  await new ClaudeRunner(fake).run(ctx, {
    call: 'claude',
    with: {
      prompt: 'hi',
      system_prompt: 'You are X',
      allowed_tools: ['Read', 'Bash'],
      permission_mode: 'acceptEdits',
      max_turns: 3,
      additional_directories: ['/tmp/extra'],
    },
  });
  expect(captured).toHaveLength(1);
  const first = captured[0];
  if (!first) throw new Error('no capture');
  const opts = first.options;
  expect(opts.systemPrompt).toBe('You are X');
  expect(opts.allowedTools).toEqual(['Read', 'Bash']);
  expect(opts.permissionMode).toBe('acceptEdits');
  expect(opts.maxTurns).toBe(3);
  expect(opts.additionalDirectories).toEqual(['/tmp/extra']);
  expect(opts.cwd).toBeDefined();
});

test('camelCase YAML keys also work and pass through', async () => {
  const captured: Captured[] = [];
  const fake = makeFakeQuery({ text: '', capture: captured });
  const ctx = new ExecutionContext({});
  await new ClaudeRunner(fake).run(ctx, {
    call: 'claude',
    with: {
      prompt: 'hi',
      systemPrompt: 'sys',
      allowedTools: ['Edit'],
      permissionMode: 'plan',
      model: 'claude-opus-4-7',
    },
  });
  const first = captured[0];
  if (!first) throw new Error('no capture');
  expect(first.options.systemPrompt).toBe('sys');
  expect(first.options.allowedTools).toEqual(['Edit']);
  expect(first.options.permissionMode).toBe('plan');
  expect(first.options.model).toBe('claude-opus-4-7');
});

test('prompt is jq-evaluated against context', async () => {
  const captured: Captured[] = [];
  const fake = makeFakeQuery({ text: 'ok', capture: captured });
  const ctx = new ExecutionContext({ input: { who: 'Mei' } });
  await new ClaudeRunner(fake).run(ctx, {
    call: 'claude',
    with: { prompt: 'hello ${ .input.who }' },
  });
  expect(captured[0]?.prompt).toBe('hello Mei');
});

test('emits text, tool_use, and tool_result via claudeEmit hooks', async () => {
  const fake = createStrictQuery(() =>
    (async function* () {
      yield assistantMessage([textBlock('first '), toolUseBlock('t1', 'Bash', { command: 'ls' })]);
      yield userToolResultMessage('t1', 'file.txt\n');
      yield assistantMessage([textBlock('second')]);
      yield resultMessage({ duration_ms: 1, total_cost_usd: 0 });
    })(),
  );

  const texts: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const toolResults: Array<{ id: string; content: string; isError: boolean }> = [];

  const ctx = new ExecutionContext({});
  ctx.claudeEmit = {
    text: (t) => texts.push(t),
    toolUse: (id, name, input) => toolUses.push({ id, name, input }),
    toolResult: (id, content, isError) => toolResults.push({ id, content, isError }),
  };

  const out = await new ClaudeRunner(fake).run(ctx, {
    call: 'claude',
    with: { prompt: 'go' },
  });

  expect(texts).toEqual(['first ', 'second']);
  expect(toolUses).toEqual([{ id: 't1', name: 'Bash', input: { command: 'ls' } }]);
  expect(toolResults).toEqual([{ id: 't1', content: 'file.txt\n', isError: false }]);
  expect(out.text).toBe('first second');
  expect(out.toolsUsed).toEqual(['Bash']);
});

test('tool_result with array content is flattened to concatenated text', async () => {
  const fake = createStrictQuery(() =>
    (async function* () {
      yield assistantMessage([toolUseBlock('t2', 'Read', { file_path: '/a' })]);
      yield userToolResultMessage(
        't2',
        [
          { type: 'text', text: 'hello\n' },
          { type: 'text', text: 'world' },
        ],
        true,
      );
      yield resultMessage({ duration_ms: 1, total_cost_usd: 0 });
    })(),
  );

  const toolResults: Array<{ id: string; content: string; isError: boolean }> = [];
  const ctx = new ExecutionContext({});
  ctx.claudeEmit = {
    toolResult: (id, content, isError) => toolResults.push({ id, content, isError }),
  };

  await new ClaudeRunner(fake).run(ctx, { call: 'claude', with: { prompt: 'p' } });

  expect(toolResults).toEqual([{ id: 't2', content: 'hello\nworld', isError: true }]);
});
