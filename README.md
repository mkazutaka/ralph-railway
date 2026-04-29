# Ralph Railway

A thin CLI that chains Claude Code and shell tasks into YAML workflows — loops, branches, and parallel fan-out in a single file.

[Ralph Loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) repeats one prompt until Claude says `DONE`. Great for one self-contained task.

But one loop isn't always enough. Ralph Railway lets you **declare that chain as a YAML workflow** and run it end-to-end. The YAMLs follow the Serverless Workflow spec, so `for` / `while` / `switch` / `fork` / `try / catch` work around the loops, not just inside them.

## Repository Layout

This is a Bun workspace monorepo:

| Path | Description |
|---|---|
| [`apps/cli`](./apps/cli) | The `way` CLI (published as `ralph-railway` on npm). |
| [`apps/web`](./apps/web) | SvelteKit web app for visualizing workflow runs. |

## Install

```bash
npm install -g ralph-railway
# or pnpm add -g ralph-railway

# you can use way command
way --version
```

## Usage

```
way <name>
```

When `<name>` is given, `way` searches in order and takes the first match:

1. `$PWD/.agents/railways/<name>.yaml` *(project, checked into the repo)*
2. `~/.agents/railways/<name>.yaml` *(user, shared across projects)*
3. `$RALPH_RAILWAYS_PATH` *(colon-separated extra dirs)*

## Example

For example, scaffolding a Next.js Todo app and iterating until it follows React best practices can be expressed as:

```yaml
document:
  dsl: "1.0.3"
  namespace: example
  name: nextjs-todo
  version: "0.1.0"
  title: "Scaffold a Next.js Todo app, then implement ↔ review on a loop"

do:
  - scaffold:
      run:
        shell:
          command: >-
            npx --yes create-next-app@latest .
            --typescript --app --tailwind --eslint --no-src-dir
            --import-alias "@/*" --use-npm --yes

  - install_skill:
      run:
        shell:
          command: >-
            npx --yes skills add vercel-labs/agent-skills
            --skill vercel-react-best-practices -a claude-code -y

  - build_loop:
      for:
        each: tick
        in: ${ [range(1; 30)] }
      while: ${ ((.output.read_review.stdout // "") | contains("<promise>APPROVED</promise>")) | not }
      do:
        - implement:
            call: claude
            with:
              prompt: |
                If REVIEW.md exists, apply the requested changes.

        - review:
            call: claude
            with:
              prompt: |
                Review app using the `react-best-practices` skill.
                Write findings to REVIEW.md, ending with
                <promise>APPROVED</promise> or <promise>CHANGES_REQUESTED</promise>.

        - read_review:
            run: { shell: { command: "cat REVIEW.md 2>/dev/null || true" } }
```

More runnable examples live in [`apps/cli/.agents/railways/`](./apps/cli/.agents/railways/).

## Supported DSL

A deliberate subset of Serverless Workflow v1.0.3:

| Task | Purpose |
|---|---|
| `set` | Assign values / jq expressions to `.output.<name>` |
| `call: claude` | Invoke Claude via `@anthropic-ai/claude-agent-sdk` (project extension) |
| `call: codex` | Invoke Codex via `@openai/codex-sdk` (project extension) |
| `run: { shell: ... }` | Run a shell command; returns `{ stdout, stderr, code }` without throwing on non-zero exit |
| `for` + `while` | Iteration with a continuation condition per spec |
| `switch` | Conditional jump to another named task |
| `fork` | Run branches in parallel and merge outputs |
| `try` / `catch` / `retry` | Failure handling with exponential backoff |
| `do` | Ordered block |
| `if` | Per-task guard (any kind). Skip the task when the runtime expression is falsy. |

For full DSL details (per-task guards, `call: claude` / `call: codex` options, shell semantics), see [`apps/cli/README.md`](./apps/cli/README.md).

## For Developers

Requirements: Node ≥ 20, [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install                    # install workspace deps

# CLI (apps/cli)
bun run cli <name>             # run the CLI from source
bun run cli:build              # compile to apps/cli/dist/cli.js
bun run cli:test               # bun test for the CLI

# Web (apps/web)
bun run web                    # start the SvelteKit dev server
bun run web:build              # production build
bun run web:test               # web tests

# Whole repo
bun run check                  # lint + typecheck + tests across workspaces
bun run build                  # build CLI and web
```
