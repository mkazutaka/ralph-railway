import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';

import type { ExecutionContext } from '../engine/context';
import type { TaskRunner } from './base';

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeRunResult {
  text: string;
  toolsUsed: string[];
  stopReason: string | null;
  numTurns: number;
  durationMs: number;
  totalCostUsd: number;
  isError: boolean;
}

const toCamel = (k: string): string => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function buildOptions(withBlock: Record<string, unknown>, cwd: string): Options {
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(withBlock)) {
    if (k === 'prompt') continue;
    normalized[toCamel(k)] ??= v;
  }
  return {
    cwd,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'auto',
    // Match claude-code's out-of-the-box defaults (see leaked
    // src/utils/queryContext.ts + src/utils/effort.ts):
    //   - thinking: adaptive — model decides when/how much to think
    //   - effort: not set — API falls back to its 'high' default
    // YAML `with.thinking` / `with.effort` override via the spread below.
    thinking: { type: 'adaptive' },
    ...normalized,
  } as Options;
}

export class ClaudeRunner implements TaskRunner {
  constructor(private readonly queryFn: QueryFn = query as unknown as QueryFn) {}

  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<ClaudeRunResult> {
    const withRaw = (body.with ?? {}) as Record<string, unknown>;
    const withBlock = (await ctx.evalValue(withRaw)) as Record<string, unknown>;

    const prompt = withBlock.prompt;
    if (typeof prompt !== 'string') {
      throw new Error('call: claude requires with.prompt');
    }

    const options = buildOptions(withBlock, ctx.workDir);
    return this.consume(prompt, options, ctx);
  }

  private async consume(
    prompt: string,
    options: Options,
    ctx: ExecutionContext,
  ): Promise<ClaudeRunResult> {
    let text = '';
    const toolsUsed: string[] = [];
    let resultMsg: SDKResultMessage | null = null;

    for await (const msg of this.queryFn({ prompt, options })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            text += block.text;
            ctx.claudeEmit.text?.(block.text);
          } else if (block.type === 'tool_use') {
            toolsUsed.push(block.name);
            const input =
              block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                ? (block.input as Record<string, unknown>)
                : {};
            ctx.claudeEmit.toolUse?.(block.id, block.name, input);
          }
        }
      } else if (msg.type === 'user') {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              ctx.claudeEmit.toolResult?.(
                block.tool_use_id,
                flattenToolResultContent(block.content),
                block.is_error === true,
              );
            }
          }
        }
      } else if (msg.type === 'result') {
        resultMsg = msg;
      }
    }

    if (!resultMsg) {
      throw new Error('call: claude stream ended without a result message');
    }

    return {
      text,
      toolsUsed,
      stopReason: resultMsg.stop_reason,
      numTurns: resultMsg.num_turns,
      durationMs: resultMsg.duration_ms,
      totalCostUsd: resultMsg.total_cost_usd,
      isError: resultMsg.is_error,
    };
  }
}

function flattenToolResultContent(content: ToolResultBlockParam['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('');
}
