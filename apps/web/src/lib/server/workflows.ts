import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const ALLOWED_EXT = new Set(['.yaml', '.yml']);

export interface WorkflowSummary {
  id: string;
  name: string;
}

export interface WorkflowStore {
  dir: string;
  list(): Promise<WorkflowSummary[]>;
  read(id: string): Promise<string>;
  write(id: string, yaml: string): Promise<void>;
  remove(id: string): Promise<void>;
}

function assertValidId(id: string): string {
  if (id !== basename(id)) throw new Error(`invalid id: ${id}`);
  if (!ALLOWED_EXT.has(extname(id))) throw new Error(`invalid extension: ${id}`);
  return id;
}

export function createWorkflowStore(dir: string): WorkflowStore {
  const root = resolve(dir);

  return {
    dir: root,

    async list() {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      return entries
        .filter((e) => e.isFile() && ALLOWED_EXT.has(extname(e.name)))
        .map((e) => ({ id: e.name, name: e.name.replace(/\.(ya?ml)$/, '') }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async read(id) {
      const safe = assertValidId(id);
      return readFile(join(root, safe), 'utf8');
    },

    async write(id, yaml) {
      const safe = assertValidId(id);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, safe), yaml, 'utf8');
    },

    async remove(id) {
      const safe = assertValidId(id);
      await unlink(join(root, safe));
    },
  };
}

export function getWorkflowsDir(): string {
  return process.env.RALPH_WORKFLOWS_DIR ?? resolve(process.cwd(), '../../.agents/railways');
}
