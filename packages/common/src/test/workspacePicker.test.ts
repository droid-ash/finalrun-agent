import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import {
  formatWorkspaceSelectionList,
  promptForWorkspaceSelection,
  WorkspaceSelectionCancelledError,
} from '../workspacePicker.js';

test('promptForWorkspaceSelection reprompts until a valid workspace number is entered', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk: Buffer | string) => {
    outputText += String(chunk);
  });
  input.write('9\n');
  setImmediate(() => {
    input.end('2\n');
  });

  const selected = await promptForWorkspaceSelection({
    heading: 'Select a workspace',
    entries: [
      {
        label: 'alpha/mobile-app',
        workspaceRoot: '/tmp/alpha-mobile-app',
      },
      {
        label: 'bravo/mobile-app',
        workspaceRoot: '/tmp/bravo-mobile-app',
      },
    ],
    io: {
      input,
      output,
      isTTY: true,
    },
  });

  assert.equal(selected.label, 'bravo/mobile-app');
  assert.match(outputText, /Invalid selection/);
});

test('promptForWorkspaceSelection rejects partially numeric answers and reprompts', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = '';
  output.on('data', (chunk: Buffer | string) => {
    outputText += String(chunk);
  });
  input.write('1foo\n');
  setImmediate(() => {
    input.end('1\n');
  });

  const selected = await promptForWorkspaceSelection({
    heading: 'Select a workspace',
    entries: [
      {
        label: 'alpha/mobile-app',
        workspaceRoot: '/tmp/alpha-mobile-app',
      },
    ],
    io: {
      input,
      output,
      isTTY: true,
    },
  });

  assert.equal(selected.label, 'alpha/mobile-app');
  assert.match(outputText, /Invalid selection/);
});

test('promptForWorkspaceSelection cancels on q and empty input', async () => {
  await assert.rejects(
    () =>
      promptForWorkspaceSelection({
        heading: 'Select a workspace',
        entries: [
          {
            label: 'alpha/mobile-app',
            workspaceRoot: '/tmp/alpha-mobile-app',
          },
        ],
        io: {
          input: Readable.from(['q\n']),
          output: new PassThrough(),
          isTTY: true,
        },
      }),
    WorkspaceSelectionCancelledError,
  );

  await assert.rejects(
    () =>
      promptForWorkspaceSelection({
        heading: 'Select a workspace',
        entries: [
          {
            label: 'alpha/mobile-app',
            workspaceRoot: '/tmp/alpha-mobile-app',
          },
        ],
        io: {
          input: Readable.from(['\n']),
          output: new PassThrough(),
          isTTY: true,
        },
      }),
    WorkspaceSelectionCancelledError,
  );
});

test('promptForWorkspaceSelection fails with the exact non-TTY message', async () => {
  await assert.rejects(
    () =>
      promptForWorkspaceSelection({
        heading: 'Select a workspace',
        entries: [
          {
            label: 'alpha/mobile-app',
            workspaceRoot: '/tmp/alpha-mobile-app',
          },
        ],
        io: {
          input: new PassThrough(),
          output: new PassThrough(),
          isTTY: false,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Interactive workspace selection requires a TTY.');
      return true;
    },
  );
});

test('formatWorkspaceSelectionList renders labels and full paths', () => {
  const rendered = formatWorkspaceSelectionList([
    {
      label: 'alpha/mobile-app',
      workspaceRoot: '/tmp/alpha-mobile-app',
    },
    {
      label: 'bravo/mobile-app',
      workspaceRoot: '/tmp/bravo-mobile-app',
    },
  ]);

  assert.match(rendered.text, /1\. alpha\/mobile-app/);
  assert.match(rendered.text, /\/tmp\/alpha-mobile-app/);
  assert.match(rendered.text, /2\. bravo\/mobile-app/);
  assert.match(rendered.text, /\/tmp\/bravo-mobile-app/);
});
