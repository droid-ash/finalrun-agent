/**
 * Shared conversion of a failed exec invocation into the command-result
 * failure shape used by both platform clients (AdbClient / SimctlClient).
 * `AndroidCommandResult` and `IOSCommandResult` are structurally identical,
 * so the one helper serves both without a cross-platform abstraction.
 */
export interface CommandFailureResult {
  success: false;
  message: string;
  stdout: string;
  stderr: string;
}

export function toCommandFailureResult(
  failurePrefix: string,
  error: unknown,
): CommandFailureResult {
  const stdout = extractStreamText(error, 'stdout');
  const stderr = extractStreamText(error, 'stderr');
  const errorMessage =
    stderr || stdout || (error instanceof Error ? error.message : String(error));

  return {
    success: false,
    message: `${failurePrefix}: ${errorMessage}`,
    stdout,
    stderr,
  };
}

function extractStreamText(error: unknown, field: 'stdout' | 'stderr'): string {
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return '';
  }

  const value = (error as Record<'stdout' | 'stderr', unknown>)[field];
  if (typeof value === 'string') {
    return value.trim();
  }
  return Buffer.isBuffer(value) ? value.toString().trim() : '';
}
