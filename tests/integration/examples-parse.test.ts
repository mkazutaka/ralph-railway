import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWorkflow } from '../../src/io';
import { listWorkflows } from '../../src/workflow-paths';

const RAILWAYS_DIR = resolve('.agents/railways');

const exampleFiles = readdirSync(RAILWAYS_DIR).filter(
  (f) => f.startsWith('example-') && (f.endsWith('.yaml') || f.endsWith('.yml')),
);

test('there is at least one example workflow', () => {
  expect(exampleFiles.length).toBeGreaterThan(0);
});

test.each(exampleFiles)('example loads and parses: %s', (file) => {
  const wf = loadWorkflow(resolve(RAILWAYS_DIR, file));
  expect(wf).toBeDefined();
  expect((wf as unknown as { document?: { name?: string } }).document?.name).toBeTruthy();
});

test('listWorkflows surfaces all example files', () => {
  const items = listWorkflows(process.cwd());
  const names = items.map((i) => i.name);
  for (const file of exampleFiles) {
    const expected = file.replace(/\.ya?ml$/, '');
    expect(names).toContain(expected);
  }
});
