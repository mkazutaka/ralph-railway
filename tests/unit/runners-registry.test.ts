import { afterEach, expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import {
  clearRegistry,
  getRunner,
  hasRunner,
  registerRunner,
  snapshotRegistry,
  type TaskRunner,
} from '../../src/runners/base';
import { CallDispatcher } from '../../src/runners/call';
import { RunDispatcher } from '../../src/runners/run';
import { SetRunner } from '../../src/runners/set';

afterEach(() => {
  clearRegistry();
  // Re-register built-in runners so subsequent test files (which rely on the
  // auto-registration in ../../src/engine/executor.ts that only fires once per
  // module import) still see them available.
  registerRunner('set', () => new SetRunner());
  registerRunner('call', () => new CallDispatcher());
  registerRunner('run', () => new RunDispatcher());
});

test('registers and retrieves a runner factory', async () => {
  class FakeRunner implements TaskRunner {
    async run(_ctx: ExecutionContext, _body: Record<string, any>) {
      return 'ok';
    }
  }
  registerRunner('fake', () => new FakeRunner());
  expect(hasRunner('fake')).toBe(true);
  expect(snapshotRegistry()).toContain('fake');

  const runner = getRunner('fake');
  expect(await runner.run(new ExecutionContext({}), {})).toBe('ok');
});

test('getRunner throws on unknown kind', () => {
  expect(() => getRunner('nope')).toThrow(/no runner registered/);
});

test('factory is invoked per getRunner call', () => {
  let count = 0;
  registerRunner('counted', () => {
    count += 1;
    return { run: async () => null };
  });
  getRunner('counted');
  getRunner('counted');
  expect(count).toBe(2);
});
