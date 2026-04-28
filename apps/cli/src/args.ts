import { WorkflowValidationError } from './engine/errors';

const TOKEN_RE = /<(ARGUMENTS|\d+)>/g;

type Token = { kind: 'all' } | { kind: 'nth'; n: number };

function scanString(s: string, into: Token[]): void {
  TOKEN_RE.lastIndex = 0;
  for (;;) {
    const m = TOKEN_RE.exec(s);
    if (!m) return;
    const inner = m[1] as string;
    if (inner === 'ARGUMENTS') into.push({ kind: 'all' });
    else {
      const n = Number(inner);
      if (n === 0) throw new WorkflowValidationError('invalid placeholder <0>: index must be >= 1');
      into.push({ kind: 'nth', n });
    }
  }
}

function walk(node: unknown, visit: (s: string) => string): unknown {
  if (typeof node === 'string') return visit(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = walk(node[i], visit);
    }
    return node;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      obj[k] = walk(obj[k], visit);
    }
    return obj;
  }
  return node;
}

/**
 * Substitute argument placeholders inside a workflow tree in-place.
 *
 * Placeholders are replaced only in string *values* — map keys are left
 * untouched. Supported forms:
 *   - `<ARGUMENTS>` — replaced with all args joined by a single space
 *   - `<N>` — replaced with the Nth argument (1-indexed; `<1>` is `args[0]`)
 *
 * The function performs a two-pass walk: the first pass collects all tokens
 * for validation, the second pass applies substitutions. This guarantees the
 * tree is never mutated when validation fails.
 *
 * @throws {WorkflowValidationError} if `<N>` exceeds the number of supplied args
 * @throws {WorkflowValidationError} if `<ARGUMENTS>` is used but no args were supplied
 * @throws {WorkflowValidationError} if args were supplied but no placeholder appears in the workflow
 * @throws {WorkflowValidationError} if `<0>` is used (index must be >= 1)
 */
export function expandArgs(wf: unknown, args: readonly string[]): void {
  const tokens: Token[] = [];
  walk(wf, (s) => {
    scanString(s, tokens);
    return s;
  });

  const maxN = tokens.reduce((m, t) => (t.kind === 'nth' ? Math.max(m, t.n) : m), 0);
  const hasAll = tokens.some((t) => t.kind === 'all');

  if (maxN > args.length) {
    throw new WorkflowValidationError(
      `workflow references <${maxN}> but only ${args.length} argument(s) supplied`,
    );
  }
  if (hasAll && args.length === 0) {
    throw new WorkflowValidationError(
      'workflow references <ARGUMENTS> but no arguments were supplied',
    );
  }
  if (args.length > 0 && tokens.length === 0) {
    throw new WorkflowValidationError(
      `workflow does not reference any of the ${args.length} argument(s) supplied ` +
        `(use <ARGUMENTS> or <N>)`,
    );
  }

  const joined = args.join(' ');
  walk(wf, (s) =>
    s.replace(TOKEN_RE, (_, inner: string) =>
      inner === 'ARGUMENTS' ? joined : (args[Number(inner) - 1] as string),
    ),
  );
}
