import { expect, test } from 'bun:test';
import { renderToString } from 'ink';
import type { Workflow } from '../../src/io';
import { Header } from '../../src/ui/Header';

function workflow(document: {
  namespace: string;
  name: string;
  version: string;
  title?: string;
  summary?: string;
}): Workflow {
  return {
    document: { dsl: '1.0.3', ...document },
    do: [],
  } as Workflow;
}

function renderHeader(input: { workflow: Workflow; columns?: number }): string {
  return renderToString(<Header workflow={input.workflow} />, { columns: input.columns });
}

function lineWidths(output: string): number[] {
  return output.split('\n').map((line) => line.length);
}

test('Header renderToString keeps border width to its content', () => {
  const output = renderHeader({
    workflow: workflow({
      namespace: 'example',
      name: 'explain-project',
      version: '0.1.0',
    }),
  });

  expect(output).toBe(
    [
      '╭─────────────────────────╮',
      '│ example/explain-project │',
      '│ v0.1.0                  │',
      '╰─────────────────────────╯',
    ].join('\n'),
  );
});

test('Header renderToString wraps a long version instead of stretching to 80 columns', () => {
  const output = renderHeader({
    workflow: workflow({
      namespace: 'example',
      name: 'explain-project',
      version: '0.1.0-alpha.20260430.1234567890+build.abcdef1234567890',
    }),
  });

  expect(output).toBe(
    [
      '╭─────────────────────────────────────────────────────────╮',
      '│ example/explain-project                                 │',
      '│ v0.1.0-alpha.20260430.1234567890+build.abcdef1234567890 │',
      '╰─────────────────────────────────────────────────────────╯',
    ].join('\n'),
  );
});

test('Header renderToString wraps a long summary at the requested render width', () => {
  const output = renderHeader({
    workflow: workflow({
      namespace: 'example',
      name: 'explain-project',
      version: '0.1.0',
      title: 'Explain this project',
      summary:
        'This workflow inspects the repository structure, reads important files, and summarizes the project architecture, dependencies, and likely development workflow for a new contributor.',
    }),
    columns: 40,
  });

  expect(output).toBe(
    [
      '╭──────────────────────────────────────╮',
      '│ example/explain-project              │',
      '│ v0.1.0                               │',
      '│ Explain this project                 │',
      '│ This workflow inspects the           │',
      '│ repository structure, reads          │',
      '│ important files, and summarizes the  │',
      '│ project architecture, dependencies,  │',
      '│ and likely development workflow for  │',
      '│ a new contributor.                   │',
      '╰──────────────────────────────────────╯',
    ].join('\n'),
  );
});

test('Header renderToString wraps very long unbroken header fields at the requested render width', () => {
  const output = renderHeader({
    workflow: workflow({
      namespace: 'example',
      name: 'explain-project',
      version: `0.1.0-${'x'.repeat(120)}`,
      title: 'T'.repeat(90),
      summary: 'S'.repeat(140),
    }),
    columns: 40,
  });

  expect(Math.max(...lineWidths(output))).toBe(40);
  expect(output).toContain('│ v0.1.0-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx │');
  expect(output).toContain('│ TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT │');
  expect(output).toContain('│ SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS │');
});

test('Header renderToString is not capped when a wider render width is requested', () => {
  const output = renderHeader({
    workflow: workflow({
      namespace: 'example',
      name: 'explain-project',
      version: `0.1.0-${'x'.repeat(120)}`,
      title: 'T'.repeat(90),
      summary: 'S'.repeat(140),
    }),
    columns: 120,
  });

  expect(Math.max(...lineWidths(output))).toBe(120);
});
