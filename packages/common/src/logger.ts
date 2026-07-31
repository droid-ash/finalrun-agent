// Port of common/FrLogger.dart — simplified for CLI use.
// Uses console.log/warn/error with log-level filtering.

/**
 * Log levels — matches typical severity ordering.
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogEntry {
  level: LogLevel;
  levelName: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  args: unknown[];
  renderedMessage: string;
  timestamp: string;
  tag: string;
}

export type LoggerSink = (entry: LogEntry) => void;

/**
 * Simple logger replacing Dart's FrLogger.
 * Singleton pattern — call Logger.init() once, then use Logger.d/i/w/e.
 *
 * Dart equivalent: common/FrLogger.dart
 */
export class Logger {
  private static _level: LogLevel = LogLevel.INFO;
  private static _tag: string = 'finalrun';
  private static _sinks: Set<LoggerSink> = new Set();

  /** Set log level and optional tag (call once at startup). */
  static init(options?: { level?: LogLevel; tag?: string; resetSinks?: boolean }): void {
    if (options?.level !== undefined) Logger._level = options.level;
    if (options?.tag) Logger._tag = options.tag;
    if (options?.resetSinks) {
      Logger._sinks.clear();
    }
  }

  static addSink(sink: LoggerSink): void {
    Logger._sinks.add(sink);
  }

  static removeSink(sink: LoggerSink): void {
    Logger._sinks.delete(sink);
  }

  static d(message: string, ...args: unknown[]): void {
    if (Logger._level <= LogLevel.DEBUG) {
      Logger._emit(LogLevel.DEBUG, 'DEBUG', message, args, console.log);
    }
  }

  static i(message: string, ...args: unknown[]): void {
    if (Logger._level <= LogLevel.INFO) {
      Logger._emit(LogLevel.INFO, 'INFO', message, args, console.log);
    }
  }

  static w(message: string, ...args: unknown[]): void {
    if (Logger._level <= LogLevel.WARN) {
      Logger._emit(LogLevel.WARN, 'WARN', `⚠ ${message}`, args, console.warn);
    }
  }

  static e(message: string, error?: unknown): void {
    if (Logger._level <= LogLevel.ERROR) {
      Logger._emit(LogLevel.ERROR, 'ERROR', `✖ ${message}`, error !== undefined ? [error] : [], console.error);
    }
  }

  private static _emit(
    level: LogLevel,
    levelName: LogEntry['levelName'],
    message: string,
    args: unknown[],
    printer: (...args: unknown[]) => void,
  ): void {
    const renderedMessage = `[${Logger._tag}] ${message}`;
    printer(renderedMessage, ...args);

    const entry: LogEntry = {
      level,
      levelName,
      message,
      args,
      renderedMessage: formatLogEntry(renderedMessage, args),
      timestamp: new Date().toISOString(),
      tag: Logger._tag,
    };

    for (const sink of Logger._sinks) {
      sink(entry);
    }
  }
}

function formatLogEntry(message: string, args: unknown[]): string {
  if (args.length === 0) {
    return message;
  }

  const renderedArgs = args.map((arg) => {
    if (typeof arg === 'string') {
      return arg;
    }

    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });

  return [message, ...renderedArgs].join(' ');
}
