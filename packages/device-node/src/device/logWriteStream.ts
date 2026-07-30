import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@finalrun/common';

/**
 * Upper bound on waiting for a stopped capture's `stdout` to reach EOF.
 *
 * By the time a provider finalizes, it has already awaited the child's `exit`,
 * so the pipe is draining a closed descriptor and reaches EOF in a few ticks.
 * The bound exists so that a child which somehow outlives its exit event costs
 * a truncated log — the old behaviour — rather than a CLI that never returns.
 */
const LOG_DRAIN_TIMEOUT_MS = 5000;

/**
 * Owns the write stream a log-capture provider pipes a child process's `stdout`
 * into, keyed by the capture's output file path (which `LogCaptureManager`
 * derives per run/test, so it is that capture's identity).
 *
 * It exists because `startLogCapture` opens the stream and `stopLogCapture`
 * receives only `{ process, outputFilePath }` — without this there is no way
 * back to the stream, which is why stopping used to call `stdout.unpipe()` and
 * nothing else. `unpipe()` detaches the pipe **without** ending the
 * destination: anything still buffered is dropped, the `finish` event never
 * fires, and the log file the CLI copies moments later is silently truncated.
 *
 * Shared by `AndroidLogcatProvider` and `IOSLogProvider` because their versions
 * of this bookkeeping diff empty modulo a log prefix — the affirmative case of
 * the measured-diff rule for the platform mirror. Kept out of the package
 * barrel: it is an internal detail of those two providers, not API.
 */
export class LogWriteStreamRegistry {
  private readonly _streams = new Map<string, fs.WriteStream>();

  /**
   * Opens the log file's write stream and tracks it under `outputFilePath`.
   * Tracking happens before the caller runs anything else that can throw, so a
   * failed start can still hand the stream to {@link finalize}.
   */
  open(outputFilePath: string): fs.WriteStream {
    const stream = fs.createWriteStream(outputFilePath);
    this._streams.set(outputFilePath, stream);
    return stream;
  }

  /**
   * Lets `source` drain to EOF so the pipe writes everything the child
   * produced, then ends the write stream and waits for its flush — so the file
   * at `outputFilePath` is complete when this resolves.
   *
   * Untracked paths (a capture that never opened a stream, a path an earlier
   * stop already finalized) and an already-finished or already-destroyed stream
   * resolve immediately: there is nothing left to flush in either case. That
   * also makes this idempotent and cheap on repeat, so a provider's error path
   * may call it without knowing whether its success path already did.
   *
   * A write error rejects, because a log that could not be flushed is a failed
   * stop, not a successful one — but the stream is ended and untracked first, on
   * every path.
   */
  async finalize(outputFilePath: string, source?: Readable | null): Promise<void> {
    const stream = this._streams.get(outputFilePath);
    if (!stream) {
      return;
    }

    try {
      const drained = await this._drain(outputFilePath, source);
      if (!drained && source) {
        // The wait timed out with `source` still attached and still producing.
        // Detach it before the `finally` ends the destination: a chunk arriving
        // after `end()` raises ERR_STREAM_WRITE_AFTER_END on the write stream,
        // which `pipe` re-emits as an unhandled `error`.
        source.unpipe(stream);
      }
    } finally {
      // Untracking and ending run even when `_drain` rejects: `finished(source)`
      // rejects when the child's `stdout` emits `error`, and `Promise.race`
      // propagates that. Bailing out there would leave the stream neither ended
      // nor tracked — the fd leaks, the log file stays truncated, and nothing
      // can ever reach the stream again, because this entry was the only handle
      // on it. Same reason the providers finalize on their error paths too.
      this._streams.delete(outputFilePath);
      await this._endAndFlush(stream);
    }
  }

  /**
   * {@link finalize} for a caller that is already returning a failure — a failed
   * start, a stop whose signal was never delivered, a stop whose wait for the
   * child threw. Those paths still MUST end the stream and drop its entry, but a
   * finalize error there must not mask the failure being reported, so it is
   * logged rather than thrown.
   *
   * Shared here rather than repeated in each provider for the same reason the
   * rest of this bookkeeping is: the two versions would differ only by a log
   * prefix, and the output file path already identifies the capture.
   */
  async finalizeQuietly(outputFilePath: string, source?: Readable | null): Promise<void> {
    try {
      await this.finalize(outputFilePath, source);
    } catch (error) {
      Logger.e(
        `LogWriteStreamRegistry: Failed to finalize log write stream: ${outputFilePath}`,
        error,
      );
    }
  }

  /**
   * Resumes `source` and waits for it to reach EOF so the pipe writes everything
   * the child produced. Resolves `true` when `source` is finished (including
   * when it already was), `false` when the wait timed out and the pipe is
   * therefore still attached. Rejects if `source` emits `error`.
   */
  private async _drain(outputFilePath: string, source?: Readable | null): Promise<boolean> {
    if (!source || source.readableEnded || source.destroyed) {
      return true;
    }

    source.resume();
    const drained = await Promise.race([
      finished(source).then(() => true),
      delay(LOG_DRAIN_TIMEOUT_MS, false, { ref: false }),
    ]);

    if (!drained) {
      Logger.w(
        `LogWriteStreamRegistry: stdout did not reach EOF within ${LOG_DRAIN_TIMEOUT_MS}ms; log may be incomplete: ${outputFilePath}`,
      );
    }
    return drained;
  }

  /**
   * Ends the write stream and waits for its flush. The pipe ends the destination
   * itself once `source` reaches EOF, so this usually finds the stream already
   * ended and only awaits the flush; the explicit `end()` covers the paths with
   * no source at all — a start that threw before spawning, or a stop whose
   * child never delivered its signal.
   */
  private async _endAndFlush(stream: fs.WriteStream): Promise<void> {
    if (stream.writableFinished || stream.destroyed) {
      return;
    }
    if (!stream.writableEnded) {
      stream.end();
    }
    await finished(stream);
  }
}
