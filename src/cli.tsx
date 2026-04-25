#!/usr/bin/env node
import { render } from 'ink';
import { isSupportedShell, renderCompletion, type Shell } from './completions';
import {
  RalphError,
  UserCancelledError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from './engine/errors';
import { EngineBus } from './engine/events';
import { Engine, type TuiController } from './engine/executor';
import { loadWorkflow, type Workflow } from './io';
import { App } from './ui/App';
import { listWorkflows, resolveWorkflow, workflowSearchDirs } from './workflow-paths';

const VERSION = '0.0.1';

interface Flags {
  help: boolean;
  version: boolean;
  verbose: boolean;
  plain: boolean;
  list: boolean;
  completions: Shell | null;
  name: string | null;
  args: string[];
  error: string | null;
}

function parseArgs(argv: string[]): Flags {
  const args = argv.slice(2);
  const flags: Flags = {
    help: false,
    version: false,
    verbose: false,
    plain: false,
    list: false,
    completions: null,
    name: null,
    args: [],
    error: null,
  };
  const positionals: string[] = [];
  let passthrough = false;
  for (const a of args) {
    if (passthrough) {
      positionals.push(a);
      continue;
    }
    switch (a) {
      case '--':
        passthrough = true;
        break;
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-V':
      case '--version':
        flags.version = true;
        break;
      case '-l':
      case '--list':
        flags.list = true;
        break;
      case '--verbose':
        flags.verbose = true;
        break;
      case '--plain':
        flags.plain = true;
        break;
      default:
        if (a.startsWith('-')) {
          flags.error = `unknown flag: ${a}`;
        } else {
          positionals.push(a);
        }
        break;
    }
  }
  if (positionals.length >= 1 && positionals[0] === 'completions') {
    const shell = positionals[1];
    if (!shell) {
      flags.error = 'completions requires a shell: bash|zsh|fish';
    } else if (!isSupportedShell(shell)) {
      flags.error = `unsupported shell: ${shell} (expected bash|zsh|fish)`;
    } else {
      flags.completions = shell;
    }
  } else if (positionals.length >= 1) {
    flags.name = positionals[0] ?? null;
    flags.args = positionals.slice(1);
  }
  return flags;
}

function usage(): string {
  return [
    `way ${VERSION}`,
    '',
    'Usage:',
    '  way <name> [arg...]   Run <name>.yaml from .agents/railways/',
    '                        Extra positionals expand <ARGUMENTS> / <N> in the YAML.',
    '                        Use `--` to forward dash-prefixed args.',
    '  way --list, -l        List available workflows',
    '  way completions <shell>',
    '                        Print shell completion script (bash|zsh|fish)',
    '  way --verbose         Print outputs JSON after completion',
    '  way --plain           Disable the live TUI (for scripts/CI)',
    '  way --version, -V',
    '  way --help, -h',
    '',
    'Search order for <name>.yaml (first match wins):',
    '  1. $PWD/.agents/railways/          (source: project)',
    '  2. ~/.agents/railways/             (source: user)',
    '  3. $RALPH_RAILWAYS_PATH (colon-separated) (source: env)',
  ].join('\n');
}

function mapErrorToExit(err: unknown): { code: number; message: string } {
  if (err instanceof WorkflowTimeoutError) return { code: 124, message: `timeout: ${err.message}` };
  if (err instanceof WorkflowValidationError) {
    return { code: 2, message: `validation: ${err.message}` };
  }
  if (err instanceof UserCancelledError) return { code: 130, message: 'cancelled by user' };
  if (err instanceof RalphError) return { code: 1, message: `error: ${err.message}` };
  return { code: 1, message: `unexpected error: ${(err as Error).message}` };
}

async function runPlain(
  wf: Workflow,
  bus: EngineBus,
  cwd: string,
  verbose: boolean,
): Promise<number> {
  const off = bus.on((e) => {
    process.stderr.write(`${JSON.stringify(e)}\n`);
  });
  try {
    const outputs = await new Engine(bus).runWorkflow(wf, { workDir: cwd });
    if (verbose) process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
    return 0;
  } catch (err) {
    const { code, message } = mapErrorToExit(err);
    process.stderr.write(`${message}\n`);
    return code;
  } finally {
    off();
  }
}

async function runInk(
  wf: Workflow,
  bus: EngineBus,
  cwd: string,
  verbose: boolean,
): Promise<number> {
  let finishedAt: number | null = null;
  let resultCode = 0;
  let resultOutputs: Record<string, unknown> | null = null;
  let resultMessage: string | null = null;

  // Mount the TUI first; App subscribes to the bus via useEffect on mount so
  // engine events stream into the reducer as the workflow runs below.
  let handle: ReturnType<typeof render> = render(<App bus={bus} wf={wf} finishedAt={finishedAt} />);

  // Hands the TTY to an interactive child by unmounting Ink, then re-mounts a
  // fresh App on the same bus when the child exits. Past Static log lines stay
  // in scrollback; the live region restarts from the next event.
  const tui: TuiController = {
    async suspend() {
      handle.unmount();
      await new Promise((r) => setTimeout(r, 30));
    },
    async resume() {
      handle = render(<App bus={bus} wf={wf} finishedAt={finishedAt} />);
    },
  };

  const engine = new Engine(bus, tui);
  try {
    resultOutputs = await engine.runWorkflow(wf, { workDir: cwd });
    finishedAt = Date.now();
    handle.rerender(<App bus={bus} wf={wf} finishedAt={finishedAt} />);
  } catch (err) {
    finishedAt = Date.now();
    handle.rerender(<App bus={bus} wf={wf} finishedAt={finishedAt} />);
    const mapped = mapErrorToExit(err);
    resultCode = mapped.code;
    resultMessage = mapped.message;
  }

  // Give Ink a frame to flush the final state, then tear down the overlay so
  // subsequent stdout/stderr writes don't get interleaved with rerenders.
  await new Promise((r) => setTimeout(r, 50));
  handle.unmount();
  await handle.waitUntilExit();

  if (resultOutputs && verbose) {
    process.stdout.write(`${JSON.stringify(resultOutputs, null, 2)}\n`);
  }
  if (resultMessage) {
    process.stderr.write(`${resultMessage}\n`);
  }
  return resultCode;
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);

  if (flags.error) {
    process.stderr.write(`${flags.error}\n${usage()}\n`);
    return 2;
  }
  if (flags.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`way ${VERSION}\n`);
    return 0;
  }
  if (flags.completions) {
    process.stdout.write(renderCompletion(flags.completions));
    return 0;
  }
  if (flags.list) {
    const items = listWorkflows(process.cwd());
    if (items.length > 0) {
      const width = Math.max(...items.map((i) => i.name.length));
      const lines = items.map((i) => `${i.name.padEnd(width)}  (${i.source})`);
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    return 0;
  }

  if (!flags.name) {
    process.stderr.write(`way requires a workflow name\n${usage()}\n`);
    return 2;
  }

  const resolved = resolveWorkflow(flags.name, process.cwd());
  if (!resolved) {
    const tried = workflowSearchDirs(process.cwd())
      .map((d) => `  - ${d.dir}/${flags.name}.yaml  (${d.source})`)
      .join('\n');
    process.stderr.write(`workflow not found: ${flags.name}\nsearched:\n${tried}\n`);
    return 2;
  }
  const path = resolved.path;

  let wf: Workflow;
  try {
    wf = loadWorkflow(path, flags.args);
  } catch (e) {
    if (e instanceof RalphError) {
      const { code, message } = mapErrorToExit(e);
      process.stderr.write(`${message}\n`);
      return code;
    }
    process.stderr.write(`failed to load workflow: ${(e as Error).message}\n`);
    return 2;
  }

  const bus = new EngineBus();
  const useInk = !flags.plain && process.stdout.isTTY === true;
  if (useInk) return runInk(wf, bus, process.cwd(), flags.verbose);
  return runPlain(wf, bus, process.cwd(), flags.verbose);
}

const code = await main(process.argv);
process.exit(code);
