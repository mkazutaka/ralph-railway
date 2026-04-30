import type { Handle } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { BODY_LIMIT_BYTES } from '$lib/server/bodyLimit';

// Cap any individual request body the routes will read. The merge step is
// O(N+M) over existing tasks so a multi-MB YAML is enough to cause memory
// pressure; the default 256 KiB comfortably fits realistic workflows and the
// shared `BODY_LIMIT_BYTES` constant (see `$lib/server/bodyLimit`) clamps the
// `RALPH_WEB_BODY_LIMIT_BYTES` override to a 4 MiB ceiling so a fat-fingered
// `1e12` cannot disable the cap entirely.

// Permit unauthenticated mutations only when the request originates from
// localhost. Production deployments must front this with their own auth
// (see review note: 認証・認可が一切無い).
//
// SECURITY: setting `RALPH_WEB_ALLOW_PUBLIC_MUTATIONS=true` *bypasses* the
// localhost guard entirely. The application has no per-user identity, so
// turning this on without a properly configured authenticating reverse
// proxy is equivalent to publishing every workflow file mutation to the
// internet. To compensate for the missing per-user identity, we additionally
// require a shared secret to be configured (`RALPH_WEB_INGRESS_SECRET`) and
// presented by every mutation request via the `x-ralph-ingress-secret`
// header. The secret is intended to be stamped in by an authenticating
// reverse proxy that has already validated the user; this gives us
// defence-in-depth so a misconfigured proxy that allows unauthenticated
// traffic through is *also* blocked here.
//
// Without that secret the localhost guard cannot be bypassed even if the
// flag is set — we fail closed at module load (see assertion below).
const ALLOW_PUBLIC_MUTATIONS = process.env.RALPH_WEB_ALLOW_PUBLIC_MUTATIONS === 'true';
const INGRESS_SECRET = process.env.RALPH_WEB_INGRESS_SECRET;
const INGRESS_SECRET_HEADER = 'x-ralph-ingress-secret';

if (ALLOW_PUBLIC_MUTATIONS) {
  if (!INGRESS_SECRET || INGRESS_SECRET.length < 16) {
    // Fail closed at startup: an operator who set the public-mutations flag
    // but forgot the secret would otherwise expose every PUT/POST/DELETE to
    // the public internet. Better to refuse to boot than to silently launch
    // a world-writable workflow directory.
    throw new Error(
      '[ralph-web] RALPH_WEB_ALLOW_PUBLIC_MUTATIONS=true requires ' +
        'RALPH_WEB_INGRESS_SECRET to be set to a value of at least 16 ' +
        'characters. The secret should be injected by your authenticating ' +
        'reverse proxy on every mutation request.',
    );
  }
  // Emitted exactly once at module load (hooks.server.ts is imported a single
  // time by the SvelteKit runtime). Operators *must* see this every restart so
  // a forgotten override doesn't quietly survive into a public deploy.
  console.warn(
    '[ralph-web] RALPH_WEB_ALLOW_PUBLIC_MUTATIONS=true — localhost guard disabled; ' +
      'mutations now require the shared ingress secret in the ' +
      `${INGRESS_SECRET_HEADER} header. Front this server with an ` +
      'authenticating reverse proxy that injects this secret only after ' +
      'verifying the requesting user.',
  );
}

// SECURITY: keep this allowlist tight. The whole mutation guard relies on
// `event.getClientAddress()` returning one of these IPs *only* for genuinely
// local traffic. The Node adapter pulls the address from the underlying
// socket, so unless the server sits behind a proxy that forwards
// `X-Forwarded-For` and `trust_proxy` is enabled by config, no remote
// attacker can spoof these values from a public network.
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isLocalClient(getClientAddress: () => string): boolean {
  let addr: string;
  try {
    addr = getClientAddress();
  } catch {
    // `getClientAddress()` throws when SvelteKit cannot determine the client
    // address (e.g. unsupported adapter). Treat that as non-local — the
    // guard is fail-closed so the worst outcome is rejecting a legitimate
    // local request, never accepting a remote one.
    return false;
  }
  return LOCALHOST_IPS.has(addr);
}

function isSameOrigin(request: Request, url: URL): boolean {
  // SECURITY (review notes M-1 / M-2): the previous implementation skipped
  // the Origin check when the request came from a localhost socket on the
  // assumption that "localhost = trusted". That assumption is wrong for
  // browser-driven CSRF: a malicious cross-origin page running in the
  // developer's browser can still issue a `fetch('http://127.0.0.1:5173/...')`
  // call, and from the server's point of view the socket address looks
  // local because the connection is local. The browser is what is
  // attacker-controlled, not the network path.
  //
  // We now *always* require the Origin / Referer header to match `url.host`
  // on non-safe methods. Same-origin browser requests always send Origin
  // (per Fetch spec); CLI tools (curl, Playwright `request`, scripts) are
  // unaffected because we accept the matching `Referer` fallback for
  // non-browser callers that omit Origin and the dedicated ingress secret
  // path for production deployments (see hooks.server.ts handler).
  //
  // SvelteKit's built-in CSRF guard only covers form content-types; this
  // hook is the only thing protecting JSON/YAML endpoints, so we cannot
  // afford the previous "localhost gets a free pass" exception.
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      // Malformed Origin header — fail closed.
      return false;
    }
  }
  // Origin missing. Some non-browser tooling (curl without `-H 'Origin: ...'`,
  // Node's `fetch` in older runtimes) does not send Origin on cross-origin
  // requests at all. Browsers always send it for cross-origin POSTs, so the
  // *absence* of Origin is itself a strong "not a browser CSRF" signal — but
  // we still verify Referer when present to leave one less degree of freedom
  // for an attacker who can craft a request that looks like a CLI.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === url.host;
    } catch {
      return false;
    }
  }
  // Neither Origin nor Referer — accept. This is the "obvious CLI / server-
  // to-server" case (no browsing context). Browsers cannot reach this branch
  // for cross-origin POSTs because they always set Origin.
  return true;
}

function hasValidIngressSecret(request: Request): boolean {
  if (!INGRESS_SECRET) return false;
  const supplied = request.headers.get(INGRESS_SECRET_HEADER);
  if (!supplied) return false;
  // Constant-time-ish equality: short circuit on length first, then compare
  // byte-by-byte. Prevents naive length-leak side channels even though Node
  // does not expose `timingSafeEqual` on plain strings without a Buffer.
  if (supplied.length !== INGRESS_SECRET.length) return false;
  let mismatch = 0;
  for (let i = 0; i < supplied.length; i += 1) {
    mismatch |= supplied.charCodeAt(i) ^ INGRESS_SECRET.charCodeAt(i);
  }
  return mismatch === 0;
}

export const handle: Handle = async ({ event, resolve }) => {
  const { request, url } = event;
  const method = request.method.toUpperCase();

  if (!SAFE_METHODS.has(method)) {
    const local = isLocalClient(event.getClientAddress);
    if (!ALLOW_PUBLIC_MUTATIONS && !local) {
      // Reject *before* parsing the body so an attacker cannot consume server
      // memory by sending a giant payload to a forbidden origin.
      throw error(403, 'mutations are restricted to localhost');
    }
    if (ALLOW_PUBLIC_MUTATIONS && !hasValidIngressSecret(request)) {
      // The startup assertion guarantees `INGRESS_SECRET` is set whenever
      // `ALLOW_PUBLIC_MUTATIONS` is true; mutation requests therefore *must*
      // present a matching shared secret. We use a generic message to avoid
      // leaking whether the secret was missing or simply mismatched.
      throw error(403, 'mutation rejected');
    }
    // SECURITY (review notes M-1 / M-2): always require Origin/Referer to
    // match for non-safe methods, regardless of whether the request came
    // from a localhost socket. The previous "localhost gets a free pass"
    // branch was exploitable by a malicious cross-origin page open in the
    // developer's browser (the server sees the socket as local even when the
    // attacker's page issued the fetch). Same-origin browser requests
    // always send Origin; CLI tools either omit both Origin/Referer (CLI
    // case, accepted) or set them to a real origin we can check.
    if (!isSameOrigin(request, url)) {
      throw error(403, 'cross-origin mutation rejected');
    }
    const lengthHeader = request.headers.get('content-length');
    if (lengthHeader) {
      const length = Number.parseInt(lengthHeader, 10);
      if (Number.isFinite(length) && length > BODY_LIMIT_BYTES) {
        throw error(413, 'request body too large');
      }
    }
  }

  return resolve(event);
};
