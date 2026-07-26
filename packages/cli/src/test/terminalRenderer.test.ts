import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalRenderer } from '../terminalRenderer.js';

test('TerminalRenderer prints provider runtime failures as errors and failed summaries', () => {
  const renderer = new TerminalRenderer();
  const terminalFailureMessage =
    'AI provider error (openai/gpt-5.4-mini, HTTP 401): Unauthorized';
  const printedLines: string[] = [];
  const originalConsoleLog = console.log;

  console.log = (...args: unknown[]) => {
    printedLines.push(args.join(' '));
  };

  try {
    renderer.onProgress({
      type: 'error',
      iteration: 1,
      totalIterations: 50,
      message: terminalFailureMessage,
    });
    renderer.printSummary({
      success: false,
      status: 'failure',
      message: terminalFailureMessage,
      terminalFailure: {
        kind: 'provider',
        provider: 'openai',
        modelName: 'gpt-5.4-mini',
        statusCode: 401,
        message: terminalFailureMessage,
      },
      platform: 'android',
      startedAt: '2026-03-30T10:00:00.000Z',
      completedAt: '2026-03-30T10:00:01.000Z',
      steps: [],
      totalIterations: 1,
    });
  } finally {
    console.log = originalConsoleLog;
    renderer.destroy();
  }

  const output = printedLines.join('\n');
  assert.match(output, /AI provider error \(openai\/gpt-5.4-mini, HTTP 401\): Unauthorized/);
  assert.match(output, /Goal failed/);
  assert.doesNotMatch(output, /Goal aborted/);
});
