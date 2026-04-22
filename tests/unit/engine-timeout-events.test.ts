/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
/** biome-ignore-all lint/suspicious/noThenProperty: `then` is the SLW DSL field name */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Classes } from '@serverlessworkflow/sdk';
import { WorkflowTimeoutError } from '../../src/engine/errors';
import { Engine } from '../../src/engine/executor';

function makeWorkflow(raw: any) {
  return new Classes.Workflow(raw) as any;
}

test('workflow timeout aborts long-running execution', async () => {
  const wf = makeWorkflow({
    document: { dsl: '1.0.3', namespace: 'ex', name: 'slow', version: '0.1.0' },
    timeout: { after: { seconds: 0 } }, // 0 -> Number(0)*1000 = 0 -> immediate
    do: [
      {
        loop: {
          for: { each: 'i', in: '${ [range(1; 100000)] }' },
          while: '${ true }',
          do: [{ noop: { set: { x: 1 } } }],
        },
      },
    ],
  });
  await expect(new Engine().runWorkflow(wf)).rejects.toThrow(WorkflowTimeoutError);
});

test('on.<name>.file.path race: file appearance jumps to then-task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'way-evt-'));
  const triggerPath = join(dir, 'go.txt');
  const handle = setTimeout(() => writeFileSync(triggerPath, 'go'), 60);
  try {
    const wf = makeWorkflow({
      document: { dsl: '1.0.3', namespace: 'ex', name: 'evt', version: '0.1.0' },
      on: {
        sig: { file: { path: triggerPath }, then: 'after' },
      },
      do: [
        {
          loop: {
            for: { each: 'i', in: '${ [range(1; 100000)] }' },
            while: '${ true }',
            do: [{ noop: { set: { x: 1 } } }],
          },
        },
        { after: { set: { handled: true } } },
      ],
    });
    const outputs = await new Engine().runWorkflow(wf);
    expect(outputs.after).toEqual({ handled: true });
  } finally {
    clearTimeout(handle);
    rmSync(dir, { recursive: true, force: true });
  }
});
