# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
bun x sv@0.15.1 create --template minimal --types ts --install bun web
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Security

This server has **no built-in authentication or authorization**. Every
GET / PUT / POST / DELETE on the workflow API and `+page.server.ts` load
function returns or mutates files inside `RALPH_WORKFLOWS_DIR` (default:
`../../.agents/railways`).

By default, write methods are restricted to requests that originate from
`localhost` (`hooks.server.ts`). The following knobs adjust that behaviour
and **must be reviewed before exposing the server beyond a single
developer machine**:

- `RALPH_WEB_ALLOW_PUBLIC_MUTATIONS=true` — disables the localhost guard
  entirely. **Requires** `RALPH_WEB_INGRESS_SECRET` to be set to a value
  of at least 16 characters; the server refuses to boot otherwise. Every
  PUT/POST/DELETE must include the secret in the
  `x-ralph-ingress-secret` header — the intent is that an authenticating
  reverse proxy injects this header only after verifying the requesting
  user. The application code itself has no per-user identity, so a
  misconfigured proxy that forwards traffic without setting the secret
  is rejected with 403 instead of silently allowed.
- `RALPH_WEB_INGRESS_SECRET` — shared secret consumed by the public
  mutations gate (see above). Keep this out of source control.
- `RALPH_WEB_BODY_LIMIT_BYTES` — caps non-safe request bodies (default
  256 KiB).
- `RALPH_WEB_DISABLE_WORKFLOW_CREATE=true` — disables the
  `POST /api/workflows` endpoint (used to create new workflow files). The
  in-app editor and form actions do not depend on it; integrators who
  only need to read or update existing files can shrink the surface
  area by setting this flag.
- `RALPH_WORKFLOWS_DIR` — root directory the routes read and write.
  Always confirm this points at a directory you intend to expose.
  Required in production builds (`NODE_ENV=production`); in development
  the server defaults to `.ralph-workflows-dev` under the working
  directory rather than the repository's tracked CLI fixtures, so
  accidental writes during `bun dev` never mutate committed files.

Read methods (GET / HEAD / OPTIONS) are not gated, including the workflow
list and individual file contents. Treat the workflow directory as
publicly readable when the server is reachable.

### Reverse-proxy / trust-proxy guidance

The localhost mutation guard reads `event.getClientAddress()`, which the
Node adapter resolves to the underlying socket peer. **Do not** enable
`trust_proxy` (or any equivalent that makes SvelteKit honour
`X-Forwarded-For`, `X-Real-IP`, etc.) when running behind nginx /
Cloudflare / a load balancer: doing so makes the localhost guard
trivially spoofable from the public internet by setting the forwarded
header. If you must run this server behind a reverse proxy that rewrites
the source address, set `RALPH_WEB_ALLOW_PUBLIC_MUTATIONS=true` and
require the reverse proxy to inject `RALPH_WEB_INGRESS_SECRET` (per
above) — that path does not depend on the client-address heuristic and
fails closed on a missing or mismatched secret.

Cross-origin defence-in-depth: every non-safe HTTP method requires the
`Origin` (or `Referer`) header to match the request's host, even on
localhost. Same-origin browser requests always send `Origin` and CLI
tools that omit both headers are unaffected, so this only blocks
cross-origin browsers — including a malicious page open in the
developer's browser that targets `http://127.0.0.1:5173`.
