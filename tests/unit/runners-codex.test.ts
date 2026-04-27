/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { type CodexClientLike, CodexRunner, type CodexThreadLike } from '../../src/runners/codex';

interface CapturedThread {
  mode: 'start' | 'resume';
  id?: string;
  options: Record<string, unknown> | undefined;
}

interface CapturedRun {
  input: unknown;
  options: Record<string, unknown> | undefined;
}

function makeFakeCodex(opts: {
  events: unknown[];
  capturedThreads?: CapturedThread[];
  capturedRuns?: CapturedRun[];
  capturedClientOptions?: Array<Record<string, unknown> | undefined>;
}): (options?: Record<string, unknown>) => CodexClientLike {
  return (clientOptions) => {
    opts.capturedClientOptions?.push(clientOptions);
    const makeThread = (id?: string): CodexThreadLike => ({
      id: id ?? 'thread-new',
      runStreamed: async (input, runOptions) => {
        opts.capturedRuns?.push({ input, options: runOptions as Record<string, unknown> });
        return {
          events: (async function* () {
            for (const event of opts.events) yield event as never;
          })(),
        };
      },
    });
    return {
      startThread: (threadOptions) => {
        opts.capturedThreads?.push({
          mode: 'start',
          options: threadOptions as Record<string, unknown>,
        });
        return makeThread();
      },
      resumeThread: (id, threadOptions) => {
        opts.capturedThreads?.push({
          mode: 'resume',
          id,
          options: threadOptions as Record<string, unknown>,
        });
        return makeThread(id);
      },
    };
  };
}

test('returns final response, thread id, usage, and completed items', async () => {
  const events = [
    { type: 'thread.started', thread_id: 'thread-123' },
    {
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'hello from codex' },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 3,
        reasoning_output_tokens: 1,
      },
    },
  ];
  const out = await new CodexRunner(makeFakeCodex({ events })).run(new ExecutionContext({}), {
    call: 'codex',
    with: { prompt: 'hi' },
  });

  expect(out.text).toBe('hello from codex');
  expect(out.finalResponse).toBe('hello from codex');
  expect(out.threadId).toBe('thread-123');
  expect(out.usage?.input_tokens).toBe(10);
  expect(out.items).toHaveLength(1);
});

test('snake_case YAML keys map to Codex client, thread, and turn options', async () => {
  const capturedClientOptions: Array<Record<string, unknown> | undefined> = [];
  const capturedThreads: CapturedThread[] = [];
  const capturedRuns: CapturedRun[] = [];
  const outputSchema = {
    type: 'object',
    properties: { status: { type: 'string' } },
    required: ['status'],
  };

  await new CodexRunner(
    makeFakeCodex({
      events: [{ type: 'turn.completed', usage: null }],
      capturedClientOptions,
      capturedThreads,
      capturedRuns,
    }),
  ).run(new ExecutionContext({ workDir: '/tmp/project' }), {
    call: 'codex',
    with: {
      prompt: 'hi',
      api_key: 'sk-test',
      base_url: 'https://example.test',
      codex_path_override: '/bin/codex',
      config: { show_raw_agent_reasoning: true },
      env: { PATH: '/bin' },
      model: 'gpt-5.4',
      sandbox_mode: 'workspace-write',
      model_reasoning_effort: 'high',
      network_access_enabled: true,
      web_search_mode: 'live',
      web_search_enabled: true,
      approval_policy: 'never',
      additional_directories: ['/tmp/extra'],
      skip_git_repo_check: true,
      output_schema: outputSchema,
    },
  });

  expect(capturedClientOptions[0]).toEqual({
    apiKey: 'sk-test',
    baseUrl: 'https://example.test',
    codexPathOverride: '/bin/codex',
    config: { show_raw_agent_reasoning: true },
    env: { PATH: '/bin' },
  });
  expect(capturedThreads[0]).toEqual({
    mode: 'start',
    options: {
      workingDirectory: '/tmp/project',
      model: 'gpt-5.4',
      sandboxMode: 'workspace-write',
      modelReasoningEffort: 'high',
      networkAccessEnabled: true,
      webSearchMode: 'live',
      webSearchEnabled: true,
      approvalPolicy: 'never',
      additionalDirectories: ['/tmp/extra'],
      skipGitRepoCheck: true,
    },
  });
  expect(capturedRuns[0]?.input).toBe('hi');
  expect(capturedRuns[0]?.options?.outputSchema).toEqual(outputSchema);
  expect(capturedRuns[0]?.options?.signal).toBeInstanceOf(AbortSignal);
});

test('thread_id resumes an existing Codex thread', async () => {
  const capturedThreads: CapturedThread[] = [];
  await new CodexRunner(
    makeFakeCodex({ events: [{ type: 'turn.completed', usage: null }], capturedThreads }),
  ).run(new ExecutionContext({}), {
    call: 'codex',
    with: { prompt: 'continue', thread_id: 'thread-old' },
  });

  expect(capturedThreads[0]?.mode).toBe('resume');
  expect(capturedThreads[0]?.id).toBe('thread-old');
});

test('prompt is jq-evaluated against context', async () => {
  const capturedRuns: CapturedRun[] = [];
  await new CodexRunner(
    makeFakeCodex({ events: [{ type: 'turn.completed', usage: null }], capturedRuns }),
  ).run(new ExecutionContext({ input: { who: 'Mei' } }), {
    call: 'codex',
    with: { prompt: 'hello ${ .input.who }' },
  });

  expect(capturedRuns[0]?.input).toBe('hello Mei');
});

test('emits agent text, reasoning, and command execution through existing hooks', async () => {
  const events = [
    {
      type: 'item.completed',
      item: { id: 'r1', type: 'reasoning', text: 'thinking...' },
    },
    {
      type: 'item.started',
      item: {
        id: 'c1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: '',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'c1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: 'ok\n',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'done' },
    },
    { type: 'turn.completed', usage: null },
  ];
  const texts: string[] = [];
  const thinking: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const toolResults: Array<{ id: string; content: string; isError: boolean }> = [];

  const ctx = new ExecutionContext({});
  ctx.claudeEmit = {
    text: (t) => texts.push(t),
    thinking: (t) => thinking.push(t),
    toolUse: (id, name, input) => toolUses.push({ id, name, input }),
    toolResult: (id, content, isError) => toolResults.push({ id, content, isError }),
  };

  const out = await new CodexRunner(makeFakeCodex({ events })).run(ctx, {
    call: 'codex',
    with: { prompt: 'go' },
  });

  expect(thinking).toEqual(['thinking...']);
  expect(texts).toEqual(['done']);
  expect(toolUses).toEqual([{ id: 'c1', name: 'Bash', input: { command: 'bun test' } }]);
  expect(toolResults).toEqual([{ id: 'c1', content: 'ok\n', isError: false }]);
  expect(out.toolsUsed).toEqual(['Bash']);
});

test('throws when prompt is missing', async () => {
  await expect(
    new CodexRunner(makeFakeCodex({ events: [] })).run(new ExecutionContext({}), {
      call: 'codex',
      with: {},
    }),
  ).rejects.toThrow(/requires with.prompt/);
});
