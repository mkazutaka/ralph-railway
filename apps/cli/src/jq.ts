import * as jq from 'jq-wasm';

const EXPR_RE = /\$\{([^}]*)\}/g;
const PURE_RE = /^\s*\$\{([^}]*)\}\s*$/;

export async function evaluate(expr: string, context: Record<string, any>): Promise<any> {
  const pure = PURE_RE.exec(expr);
  if (pure) {
    const filter = (pure[1] ?? '').trim();
    return jq.json(context, filter);
  }
  if (!expr.includes('${')) return expr;

  // Interpolation mode — stringify each match and concatenate.
  const parts: string[] = [];
  let cursor = 0;
  for (const m of expr.matchAll(EXPR_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const filter = (m[1] ?? '').trim();
    parts.push(expr.slice(cursor, start));
    const v = await jq.json(context, filter);
    parts.push(v == null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));
    cursor = end;
  }
  parts.push(expr.slice(cursor));
  return parts.join('');
}
