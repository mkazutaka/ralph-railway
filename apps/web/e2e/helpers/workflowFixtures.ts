import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The same directory the dev server points at (see playwright.config.ts).
// Using an absolute path so resolution does not depend on cwd.
const E2E_WORKFLOWS_DIR = resolve(__dirname, '../../.e2e-workflows');

export const VALID_WORKFLOW_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: insert-pattern-base
  version: '0.1.0'
do:
  - first_step:
      run:
        shell:
          command: 'echo hello'
`;

// YAML that satisfies the parser but already contains an id colliding with
// the `do` pattern's `sample_step` so we can exercise the conflict-resolution
// rename path and confirm the existing id is preserved (invariant 2).
export const WORKFLOW_WITH_SAMPLE_STEP = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: existing-sample-step
  version: '0.1.0'
do:
  - sample_step:
      run:
        shell:
          command: 'echo original'
`;

/**
 * 既存タスクが pattern template の base id と衝突する fixture を生成する。
 *
 * `mergePatternIntoDocument` のリネーム経路はテンプレート横断で同一の実装に
 * 依存しているが、`if` / `switch` / `set` の base id (`guarded_step` /
 * `route_step` / `assign_step`) について衝突パスを E2E でカバーしていな
 * かった (review 2.5 Minor 指摘)。すべての supported パターンの conflict
 * 経路を一律にパラメタライズするための builder。
 */
export function buildWorkflowWithExistingTaskId(
  baseTaskId: string,
  workflowName: string,
): string {
  return `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: ${workflowName}\n  version: '0.1.0'\ndo:\n  - ${baseTaskId}:\n      run:\n        shell:\n          command: 'echo original'\n`;
}

// Already has both `sample_step` and `sample_step_2` so a freshly-inserted
// `do` pattern must allocate `sample_step_3` (multi-step rename path).
export const WORKFLOW_WITH_TWO_SAMPLE_STEPS = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: two-sample-steps
  version: '0.1.0'
do:
  - sample_step:
      run:
        shell:
          command: 'echo first'
  - sample_step_2:
      run:
        shell:
          command: 'echo second'
`;

// Already has `loop_step` and an `inner_step` (matches the `loop` template's
// nested child) so we can exercise the recursive-id rename path while
// confirming the existing inner task is *not* renamed (invariant 2 on
// children). The existing `loop_step` forces top-level rename; the existing
// `inner_step` (nested) forces child-level rename — both must keep the
// originals untouched while allocating new ids for the inserted template.
export const WORKFLOW_WITH_LOOP_INNER = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: loop-inner-collision
  version: '0.1.0'
do:
  - loop_step:
      for:
        each: existing
        in: '\${ .var.existing }'
      do:
        - inner_step:
            run:
              shell:
                command: 'echo existing-inner'
`;

// Intentionally broken at the YAML syntax level: an unclosed flow-style
// list inside a top-level `do` is illegal for js-yaml and produces a parser
// exception. Exercises the `InvalidBaseYaml(reason)` branch from a true
// syntax error (parseWorkflowYaml -> parseError).
//
// We use `do: [unclosed` rather than the older `:::` sentinel because
// js-yaml in JSON_SCHEMA mode accepts the latter as a normal scalar key
// (`'this is not valid yaml ::': null`), which would silently fall into
// the `missing top-level do list` recovery path and break the test's
// intent. An unclosed flow node is unambiguous.
export const INVALID_WORKFLOW_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: broken
  version: '0.1.0'
do: [unclosed
`;

// Parses as YAML but violates the workflow schema (`do` is not a list of
// single-key mappings). Exercises the *schema validation* side of the
// `InvalidBaseYaml` branch — distinct from a raw syntax error.
export const SCHEMA_INVALID_WORKFLOW_YAML = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: schema-broken
  version: '0.1.0'
do:
  - just_a_string
`;

// 設計メモ (insert-pattern.md): `do` キーが欠落している base YAML は空タスク
// リスト `[]` として扱い、最初のパターン挿入を許可する。新規作成された
// ワークフローへの最初の挿入経路を担保するためのフィクスチャ。
export const WORKFLOW_WITH_MISSING_DO = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: missing-do-key
  version: '0.1.0'
`;

// 設計メモ (insert-pattern.md): `do: null` (キーは存在するが値が無い) も同様に
// 空タスクリスト `[]` として扱う。YAML lexer が `null` として解釈する経路。
export const WORKFLOW_WITH_DO_NULL = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: do-null
  version: '0.1.0'
do:
`;

// 設計メモ (insert-pattern.md:164): `do` の値がリスト型でない (スカラー /
// マッピング) ときは引き続き `InvalidBaseYaml` で拒否される。`do: 'a string'`
// は YAML 的にはパース可能だが、トップレベル `do` が配列ではないので
// `parseWorkflowYaml` が parseError (`top-level \`do\` must be a list`) を返す。
export const WORKFLOW_WITH_DO_SCALAR = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: do-scalar
  version: '0.1.0'
do: 'this is not a list'
`;

// 同上のマッピング版。`do` の値が単一マッピングであり、配列ではないので拒否。
export const WORKFLOW_WITH_DO_MAPPING = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: do-mapping
  version: '0.1.0'
do:
  not: a-list
`;

/**
 * Build a workflow whose `do` list already contains `sample_step`,
 * `sample_step_2`, ..., up to `sample_step_<count>`. Used to drive the
 * insert-pattern conflict-resolution rename loop past its allocation
 * ceiling so the API surfaces `IdConflict` instead of silently picking a
 * suffix forever.
 */
export function buildWorkflowWithSampleStepRange(count: number): string {
  if (count < 1) throw new Error('count must be >= 1');
  const entries: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = i === 1 ? 'sample_step' : `sample_step_${i}`;
    entries.push(
      `  - ${id}:\n      run:\n        shell:\n          command: 'echo ${i}'`,
    );
  }
  return `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: id-conflict-saturated\n  version: '0.1.0'\ndo:\n${entries.join('\n')}\n`;
}

/**
 * (review §3 M-6) Build a workflow whose `do` list already contains
 * `loop_step`, `loop_step_2`, ..., up to `loop_step_<count>`. The loop
 * template introduces both top-level (`loop_step`) and nested (`inner_step`)
 * task ids — saturating the top-level rename loop forces `mergePatternIntoDocument`
 * to exhaust its allocation budget across the **nested** template path
 * (in addition to the flat `do` template covered by `buildWorkflowWithSampleStepRange`).
 *
 * Each existing `loop_step_*` carries an `inner_step` child of its own so the
 * template iteration must reason about both the top-level and nested rename
 * trees while looking for a free id.
 */
export function buildWorkflowWithLoopStepRange(count: number): string {
  if (count < 1) throw new Error('count must be >= 1');
  const entries: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = i === 1 ? 'loop_step' : `loop_step_${i}`;
    entries.push(
      `  - ${id}:\n      for:\n        each: existing_${i}\n        in: '\${ .var.existing_${i} }'\n      do:\n        - inner_step:\n            run:\n              shell:\n                command: 'echo ${i}'`,
    );
  }
  return `document:\n  dsl: '1.0.0'\n  namespace: e2e\n  name: loop-saturated\n  version: '0.1.0'\ndo:\n${entries.join('\n')}\n`;
}

// Contains a task name that, if rendered without escaping, would inject HTML
// or trigger an alert dialog. Used by the security spec to confirm that the
// graph renderer and YAML textarea treat user content as text.
export const WORKFLOW_WITH_XSS_NAME = `document:
  dsl: '1.0.0'
  namespace: e2e
  name: xss-probe
  version: '0.1.0'
do:
  - "<img src=x onerror=window.__xss_alert__=1>":
      run:
        shell:
          command: 'echo xss'
`;

export interface WorkflowFixture {
  id: string;
  path: string;
  cleanup: () => Promise<void>;
  read: () => Promise<string>;
  /**
   * Overwrite the YAML file backing this fixture with `content`. Used by
   * tests that need to corrupt the YAML on-disk after the fixture has been
   * created (e.g. invalid-yaml / schema-violation cases for the run-workflow
   * spec). Goes through this helper instead of `node:fs/promises.writeFile`
   * so future cleanup hooks / abstraction changes have a single seam.
   */
  write: (content: string) => Promise<void>;
}

/**
 * Options for `createWorkflowFile`.
 *
 * `extension` lets callers exercise both `.yaml` (default) and `.yml` paths
 * through the same tracker so tests do not need to bypass the cleanup
 * machinery just to vary the suffix (review §3 M-5).
 */
export interface CreateWorkflowFileOptions {
  extension?: 'yaml' | 'yml';
}

/**
 * Create a workflow file with a unique id under the e2e workflows directory.
 * The returned `cleanup` removes the file regardless of test outcome and is
 * safe to call multiple times.
 */
export async function createWorkflowFile(
  prefix: string,
  yamlSource: string,
  options: CreateWorkflowFileOptions = {},
): Promise<WorkflowFixture> {
  await mkdir(E2E_WORKFLOWS_DIR, { recursive: true });
  const ext = options.extension ?? 'yaml';
  // Unique enough across parallel + retried runs.
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = resolve(E2E_WORKFLOWS_DIR, id);
  await writeFile(path, yamlSource, 'utf8');
  return {
    id,
    path,
    async cleanup() {
      try {
        await unlink(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    },
    async read() {
      return readFile(path, 'utf8');
    },
    async write(content: string) {
      await writeFile(path, content, 'utf8');
    },
  };
}

/**
 * Track fixtures created during a single test and provide a single cleanup
 * point. Hands callers `register` so they can spawn multiple fixtures and
 * trust them all to be removed in `afterEach`.
 */
export function createFixtureTracker() {
  const fixtures: WorkflowFixture[] = [];
  return {
    async create(
      prefix: string,
      yamlSource: string,
      options: CreateWorkflowFileOptions = {},
    ) {
      const f = await createWorkflowFile(prefix, yamlSource, options);
      fixtures.push(f);
      return f;
    },
    async cleanupAll() {
      const errors: unknown[] = [];
      for (const f of fixtures.splice(0)) {
        try {
          await f.cleanup();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}
