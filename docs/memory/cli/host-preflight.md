---
type: memory
description: "hostPreflight.ts — the host environment checks the CLI runs before a session, and the platform-branched command-on-PATH probe behind them: `resolveCommandPath` locates with `where` on win32 (first output line) and `which` elsewhere, through defaulted process-boundary overrides that make both branches test-reachable without stubbing globals."
---
# Host Preflight (cli)

**Domain**: cli

## Overview

`packages/cli/src/hostPreflight.ts` reports whether the host can run a session at all — the Android
and iOS toolchains, the driver artifacts, the recording prerequisites — as a list of
`HostPreflightCheck` records carrying a status and a `blocking` flag. Nine of those checks are
"is this command on PATH", and they all funnel through one probe whose correctness is
platform-dependent.

## Requirements

### Requirement: Command-on-PATH probing is platform-branched

`resolveCommandPath(command, overrides?)` MUST locate a command with `where` on `win32` and `which`
on every other platform — the two locators named as the constants `WINDOWS_COMMAND_LOCATOR` and
`POSIX_COMMAND_LOCATOR`. `which` does not exist on Windows, so shelling to it unconditionally makes
**every** `checkCommandOnPath` result on a Windows host a false negative: the command is reported
missing whether or not it is installed, and a blocking check then refuses a host that is fine. The
branch follows the `win32` shape already used by `upgradeCommand.ts` and `reportServerManager.ts`
rather than introducing a platform abstraction.

`where` can print several matches, one per line; the first is what the shell would actually run, so
the probe splits on `/\r?\n/` and takes the first non-empty trimmed line. `which` prints a single
line, so the same split is a no-op there and one code path serves both. The resolved path is then
confirmed to exist (`fs.access`) before being returned, and any failure — a non-zero locator exit, no
output, a path that does not resolve — yields `null` rather than throwing. The default
`hostPreflightDependencies.resolveCommand` delegates straight to it.

#### Scenario: resolving on Windows

- **GIVEN** `process.platform === 'win32'`
- **WHEN** a command is resolved
- **THEN** `where <command>` is executed and the first output line is returned as the resolved path

#### Scenario: resolving anywhere else

- **GIVEN** any other platform
- **WHEN** a command is resolved
- **THEN** `which <command>` is executed

#### Scenario: the locator finds nothing

- **GIVEN** a locator that exits non-zero, or prints nothing
- **WHEN** the probe returns
- **THEN** it returns `null`, and the check reports the command as missing

### Requirement: The platform branch is reachable by a test without stubbing globals

`resolveCommandPath` MUST take its process boundaries — the child-process runner, the platform
string, and the existence check — as a **defaulted** `overrides` parameter, and be exported so a test
can drive either branch by passing them. The defaults are the real `execFileAsync`,
`process.platform` and `fs.access`, so no call site changes. This is a defaulted parameter for
test reach, not a platform abstraction: nothing dispatches on it, and there is no second
implementation.

#### Scenario: a test pins the Windows branch

- **GIVEN** `overrides` carrying `platform: 'win32'` and a recording `execFile`
- **WHEN** `resolveCommandPath` runs
- **THEN** the recorded invocation is `where` with the command as its only argument

## Design Decisions

### The Windows branch is a defaulted-override function, not an injected dependency or a new abstraction

**Decision**: The probe is an exported module function `resolveCommandPath(command, overrides?)`
taking `{ platform, execFile, access }` with real defaults, and `hostPreflightDependencies`'s
`resolveCommand` is a one-line delegation to it.

**Why**: An inline closure over module-level `execFileAsync` and a direct `process.platform` read is
unreachable from a test — neither the locator choice nor the first-line parse can be exercised — and
the Windows path is precisely the one nobody running the suite can observe, which is how a
platform-wide false negative survives in a package with eleven test files. Defaulted overrides make
both branches reachable without stubbing globals or reshaping the
`HostPreflightDependencies` interface every check already passes around, which keeps the seam local
to the one function that needs it. Following the existing `win32` branch shape from
`upgradeCommand.ts` and `reportServerManager.ts` means a reader who has seen one has seen all three.

**Rejected**: (a) adding `platform`/`locator` fields to `HostPreflightDependencies` — widens an
interface threaded through every check to serve one function; (b) a platform-abstraction module over
command location — one branch and one call site do not justify an indirection, and it would hide the
branch this file's whole defect was about; (c) `npm`'s `which` package or a similar dependency — a new
runtime dependency to replace six lines; (d) testing through `checkCommandOnPath` with a stubbed
`resolveCommand` — that reaches only the stub, so the real default, which is where the platform
branch lives, stays unexercised.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### A platform branch that already exists twice in the package is copied, not generalized

**Decision**: The `platform === 'win32' ? … : …` test is written out in this file, as it is in
`upgradeCommand.ts` and `reportServerManager.ts`, rather than being factored into a shared
platform helper across the three.

**Why**: The three sites branch on the same predicate to do three unrelated things — choose a shell,
open a browser, locate a command — so what they share is a one-token condition, not an operation. A
helper spanning them would take a per-site pair of alternatives and read as indirection over
`process.platform`. The measured-diff test that governs this kind of call
([/device-node/android-ios-mirror.md](/device-node/android-ios-mirror.md)) answers negatively here,
and the existing precedent is what makes the copied branch immediately legible.

**Rejected**: (a) a `isWindows()`/`platformPick(win, posix)` helper — wraps a comparison and adds a
module for three call sites that share nothing else; (b) probing for `which`'s presence at runtime
instead of branching on the platform — an extra child process per check to rediscover a fact the
platform string already states.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects
