import { access, readdir, readFile, writeFile, unlink, mkdir, open } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const ALLOWED_EXT = new Set(['.yaml', '.yml']);

/**
 * Plain row shape returned by the underlying store's `list()` operation. The
 * adjacent entity equivalents live in
 * `$features/workflow-editor/entities/workflowFile.ts` (raw YAML) and
 * `$features/workflow-editor/entities/workflowSummary.ts` (display tuple);
 * branded ID validation happens at the repository boundary via the
 * `buildXxxFromRow()` constructors there (CLAUDE.md: "DB rows never leak
 * past the repository — convert via `buildXxxFromRow()` first").
 *
 * The `name` field carried here is a *cheap* basename-derived display name
 * the store can produce without reading file contents. The list-workflows
 * scenario eventually overrides it with `document.name` from inside the YAML
 * (see `lib/extractWorkflowSummary.ts`), but keeping a sensible default on
 * the row keeps the store usable by callers that do not need the rich name.
 */
export interface WorkflowSummaryRow {
  id: string;
  name: string;
}

/**
 * Result of a create-only write attempt. `'exists'` is reported when the
 * target file already exists on disk so the route layer can map it to 409
 * (review note M-3) rather than silently overwriting a workflow.
 */
export type CreateResult = 'created' | 'exists';

export interface WorkflowStore {
  dir: string;
  list(): Promise<WorkflowSummaryRow[]>;
  read(id: string): Promise<string>;
  /**
   * Cheap existence check used by the save-workflow scenario. Reading the
   * full file just to discriminate found / notFound would allocate the
   * entire YAML buffer on every save (capped at 256 KiB but still a
   * predictable waste); a dedicated probe via `fs.access` is O(1) and
   * keeps the existence check decoupled from the read path so future
   * caching / read-policy changes do not perturb the save flow.
   */
  exists(id: string): Promise<boolean>;
  write(id: string, yaml: string): Promise<void>;
  /**
   * Write `yaml` only if `id` does not already exist. Implemented atomically
   * via `fs.open(..., 'wx')` so two concurrent creates with the same id
   * cannot both succeed (one returns `'exists'`). This closes the TOCTOU
   * window between an existence check and a regular `write`.
   */
  create(id: string, yaml: string): Promise<CreateResult>;
  remove(id: string): Promise<void>;
}

/**
 * Thrown by `assertValidId` when a caller attempts to use a path component
 * that escapes the workflow directory or has an unsupported extension.
 *
 * Repository adapters branch on `instanceof InvalidWorkflowIdError` rather
 * than matching on `Error.message`, so changes to the message text below do
 * not silently degrade error handling at the route layer.
 */
export class InvalidWorkflowIdError extends Error {
  constructor(
    public readonly reason: 'invalid-id' | 'invalid-extension',
    message: string,
  ) {
    super(message);
    this.name = 'InvalidWorkflowIdError';
  }
}

function assertValidId(id: string): string {
  if (id !== basename(id)) {
    throw new InvalidWorkflowIdError('invalid-id', `invalid id: ${id}`);
  }
  if (!ALLOWED_EXT.has(extname(id))) {
    throw new InvalidWorkflowIdError('invalid-extension', `invalid extension: ${id}`);
  }
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

    async exists(id) {
      const safe = assertValidId(id);
      try {
        await access(join(root, safe));
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
        // EACCES / EPERM etc. are genuine I/O failures: surface them so the
        // route returns 500 instead of silently treating an unreadable file
        // as "not found" (which would lead the save flow to refuse a write
        // the operator probably expected to succeed once permissions are
        // fixed).
        throw e;
      }
    },

    async write(id, yaml) {
      const safe = assertValidId(id);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, safe), yaml, 'utf8');
    },

    async create(id, yaml) {
      const safe = assertValidId(id);
      await mkdir(root, { recursive: true });
      // 'wx' → fail with EEXIST if the path already exists. This is the
      // atomic equivalent of "check then write" without the TOCTOU window
      // (review note M-3).
      let handle;
      try {
        handle = await open(join(root, safe), 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw e;
      }
      try {
        await handle.writeFile(yaml, 'utf8');
      } finally {
        await handle.close();
      }
      return 'created';
    },

    async remove(id) {
      const safe = assertValidId(id);
      await unlink(join(root, safe));
    },
  };
}

/**
 * Resolve the directory the workflow store reads and writes.
 *
 * SECURITY (review note Major 3): the previous default
 * `../../.agents/railways` pointed at the repository's committed CLI fixtures,
 * which meant `bun dev` quietly mutated tracked source files the moment a
 * developer clicked "save". We now require the env var to be set in
 * production-like environments and otherwise fall back to a sandbox under the
 * working directory so that accidental writes never reach the repo.
 *
 * Operators that genuinely *want* the legacy behaviour set
 * `RALPH_WORKFLOWS_DIR=/abs/path/to/.agents/railways` explicitly.
 */
export function getWorkflowsDir(): string {
  const fromEnv = process.env.RALPH_WORKFLOWS_DIR;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[ralph-web] RALPH_WORKFLOWS_DIR is required in production builds. ' +
        'Refusing to fall back to a development sandbox so we never mutate ' +
        'the wrong directory.',
    );
  }
  return resolve(process.cwd(), '.ralph-workflows-dev');
}
