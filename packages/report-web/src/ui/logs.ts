// Log parsing helpers lifted verbatim from the legacy renderers.ts.
// Pure functions, no Node deps — safe to run on the server during SSR.

export interface ParsedLogLine {
  text: string;
  timestamp: string | undefined;
  level: 'error' | 'warn' | 'info';
}

export function parseLogTimestamp(line: string, referenceDate?: string): string | undefined {
  // Android logcat threadtime: "MM-DD HH:MM:SS.mmm ..."
  const androidMatch = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(line);
  if (androidMatch) {
    const [, month, day, hour, min, sec, ms] = androidMatch;
    const year = referenceDate ? new Date(referenceDate).getFullYear() : new Date().getFullYear();
    return new Date(
      year,
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(min, 10),
      parseInt(sec, 10),
      parseInt(ms, 10),
    ).toISOString();
  }

  // iOS compact log: "YYYY-MM-DD HH:MM:SS.mmm ..."
  const iosMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(line);
  if (iosMatch) {
    return new Date(`${iosMatch[1]}T${iosMatch[2]}`).toISOString();
  }

  return undefined;
}

export function parseLogLevel(line: string): 'error' | 'warn' | 'info' {
  const iosError = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+(E|Ef)\s/.exec(line);
  if (iosError) return 'error';
  const iosWarn = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+(W|Wf)\s/.exec(line);
  if (iosWarn) return 'warn';

  const androidMatch = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+([FEWDIV])\s/.exec(line);
  if (androidMatch) {
    const level = androidMatch[1];
    if (level === 'F' || level === 'E') return 'error';
    if (level === 'W') return 'warn';
  }

  return 'info';
}

export function parseDeviceLogLines(
  logText: string,
  recordingStartedAt?: string,
): ParsedLogLine[] {
  // No empty-string guard needed: ''.split('\n') yields [''], which the
  // zero-length filter below drops, so '' already maps to [].
  const recStartMs = recordingStartedAt ? new Date(recordingStartedAt).getTime() : undefined;
  return logText
    .split('\n')
    .filter((line) => {
      if (line.length === 0) return false;
      if (recStartMs === undefined) return true;
      const ts = parseLogTimestamp(line, recordingStartedAt);
      if (!ts) return true;
      const tsMs = new Date(ts).getTime();
      return !Number.isFinite(tsMs) || tsMs >= recStartMs;
    })
    .map((line) => ({
      text: line,
      timestamp: parseLogTimestamp(line, recordingStartedAt),
      level: parseLogLevel(line),
    }));
}
