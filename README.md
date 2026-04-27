# Ralph Railway

A thin CLI that chains Claude Code and shell tasks into YAML workflows — loops, branches, and parallel fan-out in a single file.

[Ralph Loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) repeats one prompt until Claude says `DONE`. Great for one self-contained task.

But one loop isn't always enough. Ralph Railway lets you **declare that chain as a YAML workflow** and run it end-to-end. The YAMLs follow the Serverless Workflow spec, so `for` / `while` / `switch` / `fork` / `try / catch` work around the loops, not just inside them.

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

More runnable examples live in [`.agents/railways/`](./.agents/railways/).

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

### `if` (task guard)

`if` is a per-task field defined by the SLW spec on `TaskBase`, so it can be added to any task. When the expression evaluates to a falsy value the task is skipped — the next sibling task runs as if the guarded task wasn't there. Inside a `for.do`, that gives you `continue`-style behavior.

```yaml
- loop:
    for: { each: file, in: ${ .input.files } }
    do:
      - process:
          if: ${ .var.file | endswith(".ts") }
          call: claude
          with:
            prompt: "Refactor ${ .var.file }"
```

### `call: claude`

```yaml
- task_name:
    call: claude
    with:
      prompt: "Implement the spec in spec.md"
```

The result exposes `sessionId`. Pass `resume` to continue a prior session, and
optionally `fork_session` / `resume_session_at` for forking or anchored resume:

```yaml
- first:
    call: claude
    with: { prompt: "Draft the plan" }
- followup:
    call: claude
    with:
      prompt: "Now implement step 1"
      resume: ${ .first.sessionId }
```

### `call: codex`

```yaml
- task_name:
    call: codex
    with:
      prompt: "Implement the spec in spec.md"
      model: "gpt-5.4"
      sandbox_mode: "workspace-write"
      approval_policy: "never"
```

`call: codex` forwards common Codex SDK options from `with` to the client,
thread, and turn. Snake case YAML keys are accepted, for example
`model_reasoning_effort`, `working_directory`, `output_schema`, and
`thread_id`.

The result exposes `threadId`. Pass `thread_id` on a later step to resume:

```yaml
- first:
    call: codex
    with: { prompt: "Draft the plan" }
- followup:
    call: codex
    with:
      prompt: "Now implement step 1"
      thread_id: ${ .first.threadId }
```

### `run: { shell: ... }`

```yaml
- task_name:
    run:
      shell:
        command: "bun run build"
```

Shell tasks are interactive by default: the child takes over the controlling TTY so prompts from `create-next-app`, `gh auth login`, etc. work. The TUI suspends while the child runs and resumes when it exits.

Set `interactive: false` to capture stdout/stderr into `.output.<task>.stdout` for jq expressions (`while:`, `set:`, etc.). Required when reading the task output programmatically.

```yaml
- read_review:
    run:
      shell:
        command: "cat REVIEW.md 2>/dev/null || true"
        interactive: false
```

## For Developers

Requirements: Node ≥ 20, [Bun](https://bun.sh) ≥ 1.0.

```bash
bun install                    # install deps
bun run cli <name>             # run the CLI from source
bun run check                  # biome + tsc + bun test (pre-PR gate)
bun run build                  # compile to ./dist/cli.js
```
