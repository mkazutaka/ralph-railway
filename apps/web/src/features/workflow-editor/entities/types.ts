// Branded primitives for the workflow-editor feature.
// Use the corresponding `as*` helpers to construct these from raw strings so
// that origins of trust are explicit at the call sites.

declare const WorkflowIdBrand: unique symbol;
export type WorkflowId = string & { readonly [WorkflowIdBrand]: true };

declare const PatternIdBrand: unique symbol;
export type PatternId = string & { readonly [PatternIdBrand]: true };

declare const YamlSourceBrand: unique symbol;
export type YamlSource = string & { readonly [YamlSourceBrand]: true };

declare const RunIdBrand: unique symbol;
export type RunId = string & { readonly [RunIdBrand]: true };

declare const NodeIdBrand: unique symbol;
export type NodeId = string & { readonly [NodeIdBrand]: true };

// Fail-closed branded constructors: Branded Type の意義は信頼境界で値を検査
// することなので、ここで実行時の不変条件を担保する。
//
// - WorkflowId: ファイル名相当 (basename + .yaml/.yml)。`$lib/server/workflows`
//   の `assertValidId` と同じ規則を採るので呼び出し側で重複チェック不要。
// - PatternId: シナリオの列挙 (`do, if, switch, fork, loop, try, retry, set`)
//   と将来の追加余地を許容する短い識別子に限定。長大な文字列やバイナリを
//   ブランド型へ昇格させない。
// - YamlSource: NUL バイトのみ拒否 (テキストとして扱うため)。サイズ上限は
//   レイヤー上位 (リクエストハンドラ) で扱う。

// Allow-list for valid workflow IDs.
//
// Constraint set:
// - First and last name characters must be alphanumeric or underscore so the
//   filename never starts or ends with `.` or `-` (review note Minor 7:
//   pre-tightening the regex `..yaml` and `.yaml` (basename = ".") slipped
//   through the `WORKFLOW_ID_RE` because `[A-Za-z0-9._-]+` allowed leading
//   dots; `basename('..yaml')` returns `'..yaml'` so the lower-level
//   `assertValidId` could not catch it either).
// - The middle may include `.`, `-`, `_` so common names like
//   `release.v2.yaml` and `daily-cron.yml` keep working.
// - Consecutive `..` is rejected (review note M-2): the previous regex
//   admitted names like `a..b.yaml` because `[A-Za-z0-9._-]*` permitted
//   adjacent dots. The lower-level `assertValidId` only catches path
//   separators, so `a..b.yaml` could have been written to disk verbatim.
//   Banning `..` here keeps the "valid filename" definition single-sourced.
// - Must end in `.yaml` or `.yml`.
const WORKFLOW_ID_RE = /^(?!.*\.\.)[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?\.(ya?ml)$/;
const PATTERN_ID_RE = /^[a-z][a-z0-9_-]{0,32}$/;
// Run ids are server-issued opaque identifiers (UUID-like). We only require a
// non-empty, non-control-character ASCII printable string here so the brand
// stays compatible with future id schemes (UUIDv4, ULID, snowflake) without a
// migration. The 128-character cap is a defensive ceiling for log/output
// formatting — production ids are far shorter.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Node ids are workflow-author chosen labels (e.g. `build`, `deploy-prod`).
// We accept the same printable ASCII alphabet as `PatternId` plus uppercase
// and `.` so multi-step ids like `release.v2` stay representable. The 128
// character cap mirrors `RunId` for defensive bounds on log/output formatting.
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class InvalidBrandedValueError extends Error {
  constructor(
    // Review note n4: `RunStatus` was added to the brand union so that
    // `asRunStatus` (and any future enum brand) can surface the correct
    // brand name in error messages instead of borrowing `'RunId'`.
    public readonly brand:
      | 'WorkflowId'
      | 'PatternId'
      | 'YamlSource'
      | 'RunId'
      | 'RunStatus'
      | 'NodeId'
      | 'NodeRunStatus',
    public readonly reason: string,
  ) {
    super(`invalid ${brand}: ${reason}`);
    this.name = 'InvalidBrandedValueError';
  }
}

// Most POSIX filesystems and ext4 cap a single path component at 255 bytes
// (NAME_MAX). Names longer than that surface as `ENAMETOOLONG` from the
// underlying `fs.open` call, which the route layer would otherwise have to map
// to a 5xx (review note M2). Rejecting at the brand boundary turns the failure
// into a deterministic 400 with the rest of the structural reasons.
const WORKFLOW_ID_MAX_BYTES = 255;

export function asWorkflowId(value: string): WorkflowId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidBrandedValueError('WorkflowId', 'empty');
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new InvalidBrandedValueError('WorkflowId', 'must be a basename');
  }
  if (Buffer.byteLength(value, 'utf8') > WORKFLOW_ID_MAX_BYTES) {
    throw new InvalidBrandedValueError('WorkflowId', 'too long');
  }
  if (!WORKFLOW_ID_RE.test(value)) {
    throw new InvalidBrandedValueError('WorkflowId', 'must match basename + .yaml/.yml');
  }
  return value as WorkflowId;
}

export function asPatternId(value: string): PatternId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidBrandedValueError('PatternId', 'empty');
  }
  if (!PATTERN_ID_RE.test(value)) {
    throw new InvalidBrandedValueError('PatternId', 'must match /^[a-z][a-z0-9_-]{0,32}$/');
  }
  return value as PatternId;
}

export function asRunId(value: string): RunId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidBrandedValueError('RunId', 'empty');
  }
  if (!RUN_ID_RE.test(value)) {
    throw new InvalidBrandedValueError(
      'RunId',
      'must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/',
    );
  }
  return value as RunId;
}

export function asNodeId(value: string): NodeId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidBrandedValueError('NodeId', 'empty');
  }
  if (!NODE_ID_RE.test(value)) {
    throw new InvalidBrandedValueError(
      'NodeId',
      'must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/',
    );
  }
  return value as NodeId;
}

export function asYamlSource(value: string): YamlSource {
  if (typeof value !== 'string') {
    throw new InvalidBrandedValueError('YamlSource', 'not a string');
  }
  if (value.includes('\0')) {
    throw new InvalidBrandedValueError('YamlSource', 'NUL byte not allowed');
  }
  return value as YamlSource;
}
