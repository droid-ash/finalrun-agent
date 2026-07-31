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
 * A tracked write stream plus the first `error` it emitted, if any.
 *
 * The registry tracks this rather than the bare stream because an error has to
 * outlive the event that carried it: the only place the old code could observe
 * one was `await finished(stream)` inside `_endAndFlush`, which does not exist
 * as a listener until `finalize` runs — and which `_endAndFlush` then skips
 * anyway, because an errored stream auto-destroys and hits its early return. So
 * the error is remembered here at the moment it happens, and {@link
 * LogWriteStreamRegistry.finalize} reads it back.
 *
 * Deliberately not exported: the registry itself is kept out of the package
 * barrel as an internal detail of the two log-capture providers, so its map
 * value is not API either.
 */
interface LogStreamEntry {
  readonly stream: fs.WriteStream;
  error?: Error;
}

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
  private readonly _streams = new Map<string, LogStreamEntry>();

  /**
   * Opens the log file's write stream and tracks it under `outputFilePath`.
   * Tracking happens before the caller runs anything else that can throw, so a
   * failed start can still hand the stream to {@link finalize}.
   *
   * The stream's `error` listener is attached here too — see below for why that
   * placement is load-bearing.
   */
  open(outputFilePath: string): fs.WriteStream {
    const stream = fs.createWriteStream(outputFilePath);
    const entry: LogStreamEntry = { stream };
    this._streams.set(outputFilePath, entry);

    // Attached here, before anything can pipe into the stream, and kept for the
    // stream's whole life. `createWriteStream` opens its fd asynchronously, so an
    // EACCES or a missing directory arrives as an `error` event well after this
    // returns, and every later write can fail the same way (ENOSPC). `pipe()`
    // does not forward a destination's errors to the source, so with no listener
    // the first one is an unhandled 'error' — which Node throws, taking the CLI
    // down in the middle of a run. The error is RECORDED and not merely logged
    // because `_endAndFlush` early-returns on an errored (hence auto-destroyed)
    // stream: without the record, `finalize` would resolve and report a
    // successful stop over a log file that was never written.
    stream.on('error', (error) => {
      // First error wins: it is the one that explains the failure, and anything
      // after it is fallout on an already-destroyed stream. Recorded FIRST, so
      // the record — the thing `finalize` reads to fail the stop — is in place
      // before anything fallible runs.
      entry.error ??= error;

      // The log call is guarded because THIS listener must not throw. `Logger.e`
      // is fallible INDEPENDENTLY of why this stream failed: the sink loop in
      // `Logger._emit` (`packages/common/src/logger.ts:103-105`) runs each sink
      // with no try/catch, and the CLI installs `ReportWriter.createLoggerSink()`
      // (`packages/cli/src/reportWriter.ts:132`) — an unguarded synchronous
      // `fs.appendFileSync` to the runner log — so a full disk, a permissions
      // change or a removed artifacts directory makes the log call throw on its
      // own schedule. The two can also be one failure: this stream writes under
      // `os.tmpdir()` and the runner log under the run directory, so where those
      // share a filesystem an ENOSPC that makes this stream emit `error` is apt to
      // make logging it throw too. Either way the throw escapes `emit('error')`,
      // which Node calls on a tick with no enclosing `try`, and becomes the
      // `uncaughtException` this listener exists to prevent. A listener of last
      // resort must not throw, whatever the correlation; losing a log line is the
      // cheaper outcome.
      //
      // This is NOT the shape rejected in `docs/memory/cli/session-runner.md:36`
      // ("wrapping the log call in its own try/catch"): that rejection is scoped
      // to the acquisition-ordering problem, where reordering the two statements
      // removes the window structurally and a local catch would patch one call
      // site. Here there is nothing to reorder — not throwing IS this listener's
      // contract. Do not remove the guard by citing that memory entry.
      try {
        Logger.e(`LogWriteStreamRegistry: log write stream failed: ${outputFilePath}`, error);
      } catch {
        // Deliberately empty: the record above is what `finalize` reads, and a
        // logger that just failed is not where a failing logger gets reported.
      }
    });

    return stream;
  }

  /**
   * Lets `source` drain to EOF so the pipe writes everything the child
   * produced, then ends the write stream and waits for its flush — so the file
   * at `outputFilePath` is complete when this resolves.
   *
   * Untracked paths (a capture that never opened a stream, a path an earlier
   * stop already finalized) return at once, and an already-finished or
   * already-destroyed stream skips the flush: there is nothing left to flush in
   * either case. That also makes this idempotent and cheap on repeat, so a
   * provider's error path may call it without knowing whether its success path
   * already did. A stream destroyed *by an error* is the one exception to
   * "returns quietly" — it skips the flush and then rejects with that error.
   *
   * A write error rejects, because a log that could not be flushed is a failed
   * stop, not a successful one — but the stream is ended and untracked first, on
   * every path. That holds for an error {@link open}'s listener recorded long
   * before this call as much as for one raised by the flush here. It holds even
   * when the flush itself later succeeded (`writableFinished` true): an errored
   * stream's contents are not trustworthy. `autoDestroy: true` makes that state
   * unreachable in the error-then-flush direction (a real error destroys the
   * stream before it can finish), but not in the other: auto-destroy runs
   * `close(2)` after `finish`, and a close-time failure (EIO) is recorded with
   * `writableFinished` already true — a guard on `writableFinished` here would
   * silently drop exactly that error.
   */
  async finalize(outputFilePath: string, source?: Readable | null): Promise<void> {
    const entry = this._streams.get(outputFilePath);
    if (!entry) {
      return;
    }
    const { stream } = entry;

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

    // Reached only when nothing above threw: a drain rejection or a flush error
    // is already the failure being reported, and re-throwing here would replace
    // it with a redundant one. A recorded write error still fails the stop, per
    // the contract above — a log that could not be flushed is not a stop. This
    // is also the only way such an error can surface at all: `_endAndFlush`
    // early-returns on the auto-destroyed stream an error leaves behind, so
    // without this the stop would resolve over an unwritten file.
    if (entry.error) {
      throw entry.error;
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
   *
   * Ordering matters across the two entry points: a recorded error is consumed
   * by whichever finalization runs first ({@link finalize} drops the entry in
   * its `finally`), so a quiet call before a loud one for the same path
   * swallows the error here and leaves the later {@link finalize} to find an
   * untracked path and resolve — success over a possibly-unwritten file. A
   * caller that needs the error surfaced must therefore call {@link finalize}
   * before any `finalizeQuietly` for the same path. What guarantees that today
   * lives outside this file: both providers' `stopLogCapture` run the loud call
   * on the success path before any quiet catch-path call, and
   * `LogCaptureManager`'s `_stoppedTestCases` set prevents a *sequential*
   * second stop from reaching quiet-then-loud. Overlapping calls it does not
   * cover: the set's `has()` check and its `add()` straddle the awaited
   * `stopLogCapture`, so a concurrent stop/abort pair for the same capture is a
   * check-then-act race — an accepted hazard, recorded in
   * `docs/memory/device-node/log-capture.md`.
   */
  async finalizeQuietly(outputFilePath: string, source?: Readable | null): Promise<void> {
    try {
      await this.finalize(outputFilePath, source);
    } catch (error) {
      // Guarded for the same reason {@link open}'s listener guards its own log
      // call: `Logger.e` is fallible on its own schedule, so an unguarded call
      // here would make this method reject and break the "logged rather than
      // thrown" contract above. `finalize`'s new re-throw of a recorded error is
      // what makes that reachable — this catch used to be reached only by a drain
      // or flush rejection, and on ENOSPC it now runs with the logger sink just as
      // likely to fail.
      try {
        Logger.e(
          `LogWriteStreamRegistry: Failed to finalize log write stream: ${outputFilePath}`,
          error,
        );
      } catch {
        // Deliberately empty: this path exists to swallow a failure the caller is
        // already reporting, and a logger that just failed is not where a failing
        // logger gets reported.
      }
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
   *
   * The `destroyed` early return is why a failed stream cannot report itself from
   * here: an `error` auto-destroys the stream, so by the time {@link finalize}
   * reaches this it returns without ever awaiting `finished`. {@link finalize}
   * therefore re-throws the error {@link open}'s listener recorded, after its
   * `finally`.
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
