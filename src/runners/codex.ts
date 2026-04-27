import {
  Codex,
  type CodexOptions,
  type Input,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from '@openai/codex-sdk';

import type { ExecutionContext } from '../engine/context';
import type { TaskRunner } from './base';

export interface CodexRunResult {
  text: string;
  finalResponse: string;
  threadId: string | null;
  items: ThreadItem[];
  toolsUsed: string[];
  usage: Usage | null;
  isError: boolean;
  error: string | null;
}

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: Input,
    turnOptions?: TurnOptions,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export type CodexClientFactory = (options?: CodexOptions) => CodexClientLike;

const CLIENT_OPTION_KEYS = new Set(['apiKey', 'baseUrl', 'codexPathOverride', 'config', 'env']);
const THREAD_OPTION_KEYS = new Set([
  'model',
  'sandboxMode',
  'workingDirectory',
  'skipGitRepoCheck',
  'modelReasoningEffort',
  'networkAccessEnabled',
  'webSearchMode',
  'webSearchEnabled',
  'approvalPolicy',
  'additionalDirectories',
]);

const toCamel = (k: string): string => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export class CodexRunner implements TaskRunner {
  constructor(
    private readonly codexFactory: CodexClientFactory = (options) => new Codex(options),
  ) {}

  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<CodexRunResult> {
    const withRaw = (body.with ?? {}) as Record<string, unknown>;
    const withBlock = (await ctx.evalValue(withRaw)) as Record<string, unknown>;

    const input = withBlock.prompt;
    if (typeof input !== 'string') {
      throw new Error('call: codex requires with.prompt');
    }

    const { clientOptions, threadOptions, turnOptions, threadId } = buildOptions(withBlock, ctx);
    const client = this.codexFactory(clientOptions);
    const thread =
      typeof threadId === 'string' && threadId.length > 0
        ? client.resumeThread(threadId, threadOptions)
        : client.startThread(threadOptions);

    const { events } = await thread.runStreamed(input, turnOptions);
    return consumeEvents(events, thread, ctx);
  }
}

function buildOptions(
  withBlock: Record<string, unknown>,
  ctx: ExecutionContext,
): {
  clientOptions: CodexOptions | undefined;
  threadOptions: ThreadOptions;
  turnOptions: TurnOptions;
  threadId: unknown;
} {
  const clientOptions: Record<string, unknown> = {};
  const threadOptions: Record<string, unknown> = { workingDirectory: ctx.workDir };
  const turnOptions: Record<string, unknown> = {
    signal: ctx.signal ?? new AbortController().signal,
  };
  let threadId: unknown = null;

  for (const [rawKey, value] of Object.entries(withBlock)) {
    if (rawKey === 'prompt') continue;
    const key = toCamel(rawKey);
    if (key === 'threadId') {
      threadId = value;
    } else if (key === 'outputSchema') {
      turnOptions.outputSchema = value;
    } else if (CLIENT_OPTION_KEYS.has(key)) {
      clientOptions[key] = value;
    } else if (THREAD_OPTION_KEYS.has(key)) {
      threadOptions[key] = value;
    }
  }

  return {
    clientOptions:
      Object.keys(clientOptions).length > 0 ? (clientOptions as CodexOptions) : undefined,
    threadOptions: threadOptions as ThreadOptions,
    turnOptions: turnOptions as TurnOptions,
    threadId,
  };
}

async function consumeEvents(
  events: AsyncIterable<ThreadEvent>,
  thread: CodexThreadLike,
  ctx: ExecutionContext,
): Promise<CodexRunResult> {
  let text = '';
  let usage: Usage | null = null;
  let threadId = thread.id;
  let isError = false;
  let error: string | null = null;
  const toolsUsed: string[] = [];
  const itemsById = new Map<string, ThreadItem>();
  const emittedToolUses = new Set<string>();
  const emittedToolResults = new Set<string>();

  const markTool = (name: string) => {
    toolsUsed.push(name);
  };

  for await (const event of events) {
    switch (event.type) {
      case 'thread.started':
        threadId = event.thread_id;
        break;
      case 'turn.completed':
        usage = event.usage;
        break;
      case 'turn.failed':
        isError = true;
        error = event.error.message;
        break;
      case 'error':
        isError = true;
        error = event.message;
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        itemsById.set(item.id, item);
        if (item.type === 'agent_message' && event.type === 'item.completed') {
          text += item.text;
          // Reuse the existing agent streaming channel. The UI names these
          // events after Claude, but they render generic text/tool rows.
          ctx.claudeEmit.text?.(item.text);
        } else if (item.type === 'reasoning' && event.type === 'item.completed') {
          ctx.claudeEmit.thinking?.(item.text);
        } else {
          handleToolItem(item, event.type === 'item.completed', {
            toolsUsed,
            markTool,
            emittedToolUses,
            emittedToolResults,
            ctx,
          });
        }
        break;
      }
      case 'turn.started':
        break;
    }
  }

  return {
    text,
    finalResponse: text,
    threadId,
    items: [...itemsById.values()],
    toolsUsed,
    usage,
    isError,
    error,
  };
}

function handleToolItem(
  item: ThreadItem,
  completed: boolean,
  state: {
    toolsUsed: string[];
    markTool: (name: string) => void;
    emittedToolUses: Set<string>;
    emittedToolResults: Set<string>;
    ctx: ExecutionContext;
  },
): void {
  const tool = toolUseForItem(item);
  if (!tool) return;

  if (!state.emittedToolUses.has(item.id)) {
    state.emittedToolUses.add(item.id);
    state.markTool(tool.name);
    state.ctx.claudeEmit.toolUse?.(item.id, tool.name, tool.input);
  }

  if (completed && !state.emittedToolResults.has(item.id)) {
    state.emittedToolResults.add(item.id);
    state.ctx.claudeEmit.toolResult?.(item.id, tool.resultContent, tool.isError);
  }
}

function toolUseForItem(item: ThreadItem): {
  name: string;
  input: Record<string, unknown>;
  resultContent: string;
  isError: boolean;
} | null {
  switch (item.type) {
    case 'command_execution':
      return {
        name: 'Bash',
        input: { command: item.command },
        resultContent: item.aggregated_output,
        isError: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0),
      };
    case 'file_change':
      return {
        name: 'ApplyPatch',
        input: { changes: item.changes },
        resultContent: item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n'),
        isError: item.status === 'failed',
      };
    case 'mcp_tool_call':
      return {
        name: `${item.server}.${item.tool}`,
        input:
          item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
            ? (item.arguments as Record<string, unknown>)
            : { arguments: item.arguments },
        resultContent: item.error?.message ?? formatMcpResult(item.result),
        isError: item.status === 'failed' || item.error != null,
      };
    case 'web_search':
      return {
        name: 'WebSearch',
        input: { query: item.query },
        resultContent: '',
        isError: false,
      };
    case 'error':
      return {
        name: 'Error',
        input: {},
        resultContent: item.message,
        isError: true,
      };
    case 'agent_message':
    case 'reasoning':
    case 'todo_list':
      return null;
  }
}

function formatMcpResult(result: Extract<ThreadItem, { type: 'mcp_tool_call' }>['result']): string {
  if (!result) return '';
  const content = result.content
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('');
  const structured =
    result.structured_content == null ? '' : JSON.stringify(result.structured_content);
  return [content, structured].filter(Boolean).join('\n');
}
