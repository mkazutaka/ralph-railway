import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWorkflow } from '../../src/io';
import { listWorkflows } from '../../src/workflow-paths';

// The example workflows live at the repo root, not inside this package.
// Resolve relative to the test file so the suite is cwd-independent.
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const RAILWAYS_DIR = resolve(REPO_ROOT, '.agents/railways');

const exampleFiles = readdirSync(RAILWAYS_DIR).filter(
  (f) => f.startsWith('example-') && (f.endsWith('.yaml') || f.endsWith('.yml')),
);

test('there is at least one example workflow', () => {
  expect(exampleFiles.length).toBeGreaterThan(0);
});

test.each(exampleFiles)('example loads and parses: %s', (file) => {
  // Pass dummy args only when the example references <ARGUMENTS> / <N>.
  // expandArgs is bidirectional: it rejects placeholders without args AND
  // args without placeholders, so we mirror the file's expectation.
  const path = resolve(RAILWAYS_DIR, file);
  const text = readFileSync(path, 'utf-8');
  const args = /<(ARGUMENTS|\d+)>/.test(text) ? ['dummy-arg'] : [];
  const wf = loadWorkflow(path, args);
  expect(wf).toBeDefined();
  expect((wf as unknown as { document?: { name?: string } }).document?.name).toBeTruthy();
});

test('listWorkflows surfaces all example files', () => {
  const items = listWorkflows(REPO_ROOT);
  const names = items.map((i) => i.name);
  for (const file of exampleFiles) {
    const expected = file.replace(/\.ya?ml$/, '');
    expect(names).toContain(expected);
  }
});
