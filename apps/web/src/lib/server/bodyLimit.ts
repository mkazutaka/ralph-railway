// Single-sourced request body cap shared between `hooks.server.ts` and any
// route that wants to apply a defence-in-depth size check at the route layer
// (review note M1: the hooks-level `Content-Length` check is bypassed by
// `Transfer-Encoding: chunked`, so routes that read JSON bodies should also
// measure size themselves using this same constant).
//
// The cap is sourced from `RALPH_WEB_BODY_LIMIT_BYTES`, defaults to 256 KiB,
// and is clamped to 4 MiB to prevent an operator-typoed `1e12` from disabling
// the cap entirely.

const BODY_LIMIT_DEFAULT_BYTES = 256 * 1024;
const BODY_LIMIT_MAX_BYTES = 4 * 1024 * 1024;

export const BODY_LIMIT_BYTES = (() => {
  const raw = process.env.RALPH_WEB_BODY_LIMIT_BYTES;
  const n = raw ? Number.parseInt(raw, 10) : BODY_LIMIT_DEFAULT_BYTES;
  if (!Number.isFinite(n) || n <= 0) return BODY_LIMIT_DEFAULT_BYTES;
  return Math.min(n, BODY_LIMIT_MAX_BYTES);
})();
