/**
 * Retention bound for diagnostic output buffers accumulated from a child
 * process's stdout/stderr `data` events, using the bounded-ring idiom the
 * gRPC setups already established for their `recentLogs` rings (`push`, then
 * `shift()` past the cap): retain the most recent chunks, drop the oldest.
 * Keeping the tail is the better diagnostic — a startup crash exits fast
 * enough that first and last coincide, while for a long-running process the
 * most recent output is what explains a failure.
 *
 * Shared by `device/AndroidRecordingProvider.ts` (scrcpy startup diagnostics)
 * and `discovery/DeviceDiscoveryService.ts` (emulator startup transcript) — a
 * shared *constant* only: the two accumulator bodies were diffed and differ
 * (closure-local arrays with per-chunk logging vs. silent pushes onto a
 * capture context), so per the mirror rule (measured identity, not parallel
 * shape) the push logic stays per-site. This module is deliberately a
 * zero-import leaf at the call sites' nearest common parent and is not
 * exported from the package barrel.
 */
export const MAX_DIAGNOSTIC_OUTPUT_CHUNKS = 20;
