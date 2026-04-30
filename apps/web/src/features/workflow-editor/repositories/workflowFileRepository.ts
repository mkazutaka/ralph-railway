import type { WorkflowStore } from '$lib/server/workflows';
import { InvalidWorkflowIdError } from '$lib/server/workflows';
import type { WorkflowId, YamlSource } from '../entities/types';
import { asYamlSource } from '../entities/types';
import type { WorkflowFile } from '../entities/workflowFile';
import { buildWorkflowFileFromRow } from '../entities/workflowFile';

export type ReadWorkflowFileResult =
  | { kind: 'found'; yaml: YamlSource }
  | { kind: 'notFound' };

export type WriteWorkflowFileResult =
  | { kind: 'written' }
  | { kind: 'invalidId'; reason: string }
  /**
   * Persistence layer rejected the write for an I/O reason (permission
   * denied, disk full, ENOSPC, ...). Surfaced as a discriminated variant —
   * rather than thrown — because the save-workflow scenario lists
   * `StorageFailure` as an explicit output of the `writeWorkflowFile`
   * dependency. Treating it as data keeps the workflow layer free of
   * try/catch and ensures the route can return a deterministic 500 with a
   * generic message instead of leaking `errno` details. The `reason` is for
   * server-side logging only — callers must not echo it to clients.
   */
  | { kind: 'storageFailure'; reason: string };

/**
 * Result of a create-only write. `'alreadyExists'` is the failure mode the
 * "create new workflow" REST endpoint maps to 409 (review note M-3) so that
 * a typo in the new-workflow form cannot silently overwrite an existing
 * workflow. `'invalidId'` mirrors `WriteWorkflowFileResult` for symmetry —
 * a malformed id is the same kind of structural failure regardless of
 * whether we were creating or replacing.
 */
export type CreateWorkflowFileResult =
  | { kind: 'created' }
  | { kind: 'alreadyExists' }
  | { kind: 'invalidId'; reason: string };

export type RemoveWorkflowFileResult =
  | { kind: 'removed' }
  | { kind: 'notFound' };

export type ReadWorkflowFile = (id: WorkflowId) => Promise<ReadWorkflowFileResult>;
export type WriteWorkflowFile = (
  id: WorkflowId,
  yaml: YamlSource,
) => Promise<WriteWorkflowFileResult>;
export type CreateWorkflowFile = (
  id: WorkflowId,
  yaml: YamlSource,
) => Promise<CreateWorkflowFileResult>;
export type RemoveWorkflowFile = (id: WorkflowId) => Promise<RemoveWorkflowFileResult>;
/**
 * Realises the `listWorkflowFiles: void -> WorkflowFile[]` dependency from
 * the list-workflows scenario. Returns the raw YAML source for each file so
 * the workflow layer can run `extractWorkflowSummary` (with its filename
 * fallback) without re-reading the file. Files whose contents fail to read
 * (race with deletion, permission flap) are silently dropped — the scenario
 * treats the listing as best-effort and a missing file is functionally
 * equivalent to one that was never there in the first place.
 */
export type ListWorkflowFiles = () => Promise<ReadonlyArray<WorkflowFile>>;

/**
 * Realises the `workflowExists: WorkflowId -> bool` dependency from the
 * save-workflow scenario. Implemented as an O(1) `fs.access` probe rather
 * than a full read so the existence check stays cheap on the save hot path
 * (the YAML buffer can be up to 256 KiB and reading it just to discriminate
 * found / notFound would be wasteful). Genuine I/O failures (permission
 * denied, disk failure) propagate as throws so the route layer can map
 * them to a generic 500.
 */
export type WorkflowFileExists = (id: WorkflowId) => Promise<boolean>;

export interface WorkflowFileRepository {
  readWorkflowFile: ReadWorkflowFile;
  workflowFileExists: WorkflowFileExists;
  writeWorkflowFile: WriteWorkflowFile;
  createWorkflowFile: CreateWorkflowFile;
  removeWorkflowFile: RemoveWorkflowFile;
  listWorkflowFiles: ListWorkflowFiles;
}

/**
 * Adapt the lower-level `WorkflowStore` (filesystem) into the repository
 * functions used by the workflow-editor feature. Throwing APIs are converted
 * to sum-types so workflows can branch without try/catch and so that errors
 * representing "expected" outcomes don't bubble up as 500s.
 *
 * Genuine I/O failures (permission denied, disk full, ...) still throw — the
 * route layer maps those to a generic 500 without leaking the underlying
 * error message.
 */
export function toWorkflowFileRepository(store: WorkflowStore): WorkflowFileRepository {
  return {
    async readWorkflowFile(id) {
      try {
        const text = await store.read(id);
        return { kind: 'found', yaml: asYamlSource(text) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return { kind: 'notFound' };
        }
        throw e;
      }
    },
    async workflowFileExists(id) {
      // `store.exists` throws `InvalidWorkflowIdError` for malformed names.
      // The save-workflow scenario expects `validateWorkflowId` to have
      // already run by the time we reach this dependency, so reaching the
      // exists probe with an invalid id signals a programming error rather
      // than user input — let it propagate (it'll surface as a 500, which
      // is the right answer for a contract violation).
      return store.exists(id);
    },
    async writeWorkflowFile(id, yaml) {
      try {
        await store.write(id, yaml);
        return { kind: 'written' };
      } catch (e) {
        // `assertValidId` in the store throws `InvalidWorkflowIdError` for
        // malformed names; surface that as a structured result so the route
        // can return 400 without depending on `Error.message` string matching.
        if (e instanceof InvalidWorkflowIdError) {
          return { kind: 'invalidId', reason: e.message };
        }
        // Genuine I/O failure. The save-workflow scenario lists
        // `StorageFailure` as an explicit dependency outcome, so surface it
        // as data instead of letting the throw bubble up — this keeps the
        // workflow layer free of try/catch and lets the route map it to a
        // 500 with a generic message that does not leak `errno` codes.
        return {
          kind: 'storageFailure',
          reason: (e as Error).message ?? 'unknown write failure',
        };
      }
    },
    async createWorkflowFile(id, yaml) {
      try {
        const result = await store.create(id, yaml);
        if (result === 'exists') return { kind: 'alreadyExists' };
        return { kind: 'created' };
      } catch (e) {
        if (e instanceof InvalidWorkflowIdError) {
          return { kind: 'invalidId', reason: e.message };
        }
        throw e;
      }
    },
    async removeWorkflowFile(id) {
      try {
        await store.remove(id);
        return { kind: 'removed' };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return { kind: 'notFound' };
        }
        throw e;
      }
    },
    async listWorkflowFiles() {
      // CLAUDE.md rule: never leak DB rows past the repository — convert via
      // `buildXxxFromRow()` first so the entity layer stays self-contained
      // and ID branding is enforced at the boundary.
      //
      // The list-workflows scenario requires the *raw YAML source* for each
      // file so the workflow layer can extract `document.name` (or fall back
      // to the basename). We therefore read each entry's content here. The
      // reads are issued in parallel via `Promise.allSettled` so a single
      // slow file does not serialise the whole listing, and a transient
      // ENOENT on one entry (e.g. it was deleted between `list()` and
      // `read()`) drops only that entry instead of failing the whole call.
      const rows = await store.list();
      const reads = await Promise.allSettled(
        rows.map(async (row) => {
          const yaml = await store.read(row.id);
          return buildWorkflowFileFromRow({ id: row.id, yaml });
        }),
      );
      const files: WorkflowFile[] = [];
      for (const result of reads) {
        if (result.status === 'fulfilled') {
          files.push(result.value);
        }
        // Rejected reads are intentionally swallowed: they represent a race
        // between `list()` and `read()` (file deleted, permission flap) and
        // the scenario's invariant 1 ("0件含む") explicitly tolerates an
        // empty listing, so dropping a single transient failure is preferable
        // to surfacing a 5xx for a partially-readable directory. Genuine
        // configuration errors (the directory itself is unreadable) still
        // throw from `store.list()` above and propagate to the route.
      }
      return files;
    },
  };
}
