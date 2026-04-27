import type { ExecutionContext } from '../engine/context';
import { registerRunner, type TaskRunner } from './base';

export class CallDispatcher implements TaskRunner {
  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown> {
    const kind = body.call;
    if (kind === 'claude') {
      const { ClaudeRunner } = await import('./claude');
      return new ClaudeRunner().run(ctx, body);
    }
    if (kind === 'codex') {
      const { CodexRunner } = await import('./codex');
      return new CodexRunner().run(ctx, body);
    }
    throw new Error(`call: ${kind} is not supported`);
  }
}

registerRunner('call', () => new CallDispatcher());
