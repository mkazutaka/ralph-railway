import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflowStore } from './workflows';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ralph-web-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('workflow store', () => {
  it('lists yaml files only, sorted by id', async () => {
    writeFileSync(join(dir, 'b.yaml'), 'document:\n  name: b\n  version: "1.0"\n');
    writeFileSync(join(dir, 'a.yml'), 'document:\n  name: a\n  version: "1.0"\n');
    writeFileSync(join(dir, 'c.txt'), 'ignored');
    const store = createWorkflowStore(dir);
    const list = await store.list();
    expect(list.map((w) => w.id)).toEqual(['a.yml', 'b.yaml']);
    expect(list.map((w) => w.name)).toEqual(['a', 'b']);
  });

  it('returns an empty list when the directory does not exist yet', async () => {
    const store = createWorkflowStore(join(dir, 'nope'));
    expect(await store.list()).toEqual([]);
  });

  it('rejects ids with path separators', async () => {
    const store = createWorkflowStore(dir);
    await expect(store.read('../escape.yaml')).rejects.toThrow(/invalid/i);
    await expect(store.write('a/b.yaml', 'foo')).rejects.toThrow(/invalid/i);
  });

  it('rejects ids without a .yaml or .yml extension', async () => {
    const store = createWorkflowStore(dir);
    await expect(store.read('demo.txt')).rejects.toThrow(/invalid/i);
    await expect(store.write('demo', 'foo')).rejects.toThrow(/invalid/i);
  });

  it('round-trips a saved workflow', async () => {
    const store = createWorkflowStore(dir);
    await store.write('demo.yaml', 'document:\n  name: demo\n  version: "1.0"\n');
    const got = await store.read('demo.yaml');
    expect(got).toContain('name: demo');
  });

  it('removes a workflow', async () => {
    const store = createWorkflowStore(dir);
    await store.write('demo.yaml', 'document: {}');
    await store.remove('demo.yaml');
    expect((await store.list()).length).toBe(0);
  });

  // Create-only path: review note M-3. Two simultaneous creates with the
  // same id must not silently overwrite each other; the second must observe
  // `'exists'` so the route layer can map it to 409.
  it('create() succeeds when the file does not exist yet', async () => {
    const store = createWorkflowStore(dir);
    const result = await store.create('fresh.yaml', 'document:\n  name: fresh\n');
    expect(result).toBe('created');
    expect(await store.read('fresh.yaml')).toContain('name: fresh');
  });

  it('create() reports `exists` when the file is already present', async () => {
    const store = createWorkflowStore(dir);
    await store.write('demo.yaml', 'document:\n  name: original\n');
    const result = await store.create('demo.yaml', 'document:\n  name: replaced\n');
    expect(result).toBe('exists');
    // The original content must NOT have been overwritten — that is the
    // whole point of the create-only path.
    expect(await store.read('demo.yaml')).toContain('name: original');
  });

  it('create() rejects ids without a .yaml or .yml extension', async () => {
    const store = createWorkflowStore(dir);
    await expect(store.create('demo.txt', 'foo')).rejects.toThrow(/invalid/i);
  });
});
