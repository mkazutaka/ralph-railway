import { randomUUID } from 'node:crypto';
import type {
  ModelUsage,
  NonNullableUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { QueryFn } from '../../src/runners/claude';

type AssistantContent = SDKAssistantMessage['message']['content'];
type AssistantTextBlock = Extract<AssistantContent[number], { type: 'text' }>;
type AssistantToolUseBlock = Extract<AssistantContent[number], { type: 'tool_use' }>;

interface ResultMessageOverrides {
  subtype?: SDKResultMessage['subtype'];
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  num_turns?: number;
  stop_reason?: string | null;
  total_cost_usd?: number;
  result?: string;
  errors?: string[];
  session_id?: string;
}

export function createStrictQuery(
  handler: (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>,
): QueryFn {
  return (params) => handler(params);
}

export function textBlock(text: string): AssistantTextBlock {
  return {
    type: 'text',
    text,
    citations: null,
  } satisfies AssistantTextBlock;
}

export function toolUseBlock(id: string, name: string, input: unknown = {}): AssistantToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
  } satisfies AssistantToolUseBlock;
}

export function assistantMessage(content: AssistantContent): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: `msg_${randomUUID()}`,
      container: null,
      content,
      context_management: null,
      model: 'claude-sonnet-4-5',
      role: 'assistant',
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: nullableUsage(),
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: randomUUID(),
  } satisfies SDKAssistantMessage;
}

export function userToolResultMessage(
  toolUseId: string,
  content: ToolResultBlockParam['content'],
  isError = false,
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: randomUUID(),
  } satisfies SDKUserMessage;
}

export function resultMessage(overrides: ResultMessageOverrides = {}): SDKResultMessage {
  const subtype = overrides.subtype ?? 'success';
  const common = {
    type: 'result' as const,
    duration_ms: overrides.duration_ms ?? 5,
    duration_api_ms: overrides.duration_api_ms ?? overrides.duration_ms ?? 5,
    is_error: overrides.is_error ?? subtype !== 'success',
    num_turns: overrides.num_turns ?? 1,
    stop_reason: overrides.stop_reason ?? 'end_turn',
    total_cost_usd: overrides.total_cost_usd ?? 0.0001,
    usage: nonNullableUsage(),
    modelUsage: modelUsage(),
    permission_denials: [],
    uuid: randomUUID(),
    session_id: overrides.session_id ?? randomUUID(),
  };

  if (subtype === 'success') {
    return {
      ...common,
      subtype,
      result: overrides.result ?? '',
    } satisfies SDKResultMessage;
  }

  return {
    ...common,
    subtype,
    errors: overrides.errors ?? [],
  } satisfies SDKResultMessage;
}

function modelUsage(): Record<string, ModelUsage> {
  return {
    'claude-sonnet-4-5': {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 200000,
      maxOutputTokens: 4096,
    },
  };
}

function nonNullableUsage(): NonNullableUsage {
  return {
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: '',
    input_tokens: 0,
    iterations: [],
    output_tokens: 0,
    server_tool_use: {
      web_fetch_requests: 0,
      web_search_requests: 0,
    },
    service_tier: 'standard',
    speed: 'standard',
  };
}

function nullableUsage(): SDKAssistantMessage['message']['usage'] {
  return {
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    input_tokens: 0,
    iterations: null,
    output_tokens: 0,
    server_tool_use: null,
    service_tier: 'standard',
    speed: 'standard',
  };
}
