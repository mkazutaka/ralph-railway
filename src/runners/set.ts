import type { ExecutionContext } from '../engine/context';
import { registerRunner, type TaskRunner } from './base';

export class SetRunner implements TaskRunner {
  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown> {
    const set = body.set ?? {};
    return ctx.evalValue(set);
  }
}

registerRunner('set', () => new SetRunner());
