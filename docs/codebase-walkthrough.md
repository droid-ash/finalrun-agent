# FinalRun Codebase Walkthrough

A complete guide to understanding how FinalRun works, from CLI invocation to test execution to report display.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [What the User Writes (Input YAML Files)](#2-what-the-user-writes-input-yaml-files)
3. [CLI Entry Point & Command Dispatch](#3-cli-entry-point--command-dispatch)
4. [Phase 1: Validation (`runCheck`)](#4-phase-1-validation-runcheck)
5. [Phase 2: Device Setup (`prepareTestSession`)](#5-phase-2-device-setup-preparetestsession)
6. [Phase 3: Test Execution Loop](#6-phase-3-test-execution-loop)
7. [The Goal Executor (AI Brain)](#7-the-goal-executor-ai-brain)
8. [The Device Layer (Physical Actions)](#8-the-device-layer-physical-actions)
9. [Phase 4: Artifact Writing](#9-phase-4-artifact-writing)
10. [Phase 5: Report Server & Display](#10-phase-5-report-server--display)
11. [Complete Data Flow Diagram](#11-complete-data-flow-diagram)
12. [JSON Artifacts Reference](#12-json-artifacts-reference)
13. [Package Map](#13-package-map)

---

## 1. Architecture Overview

FinalRun is a **monorepo with 7 packages** that together form an AI-powered mobile app testing tool:

```text
finalrun-ts/
├── packages/
│   ├── common/          Shared TypeScript types (the "contract" between packages)
│   ├── cli/             CLI commands, test orchestration, report server, artifact writing
│   ├── goal-executor/   AI agent loop: screenshot → LLM plan → device action → repeat
│   ├── device-node/     Device management: gRPC driver, screenshots, action execution
│   ├── cloud-core/      Cloud-submission logic, bundled into the compiled CLI binary
│   ├── local-runtime/   Per-platform runtime asset bundle (driver APKs/iOS zips, proto, report SPA dist)
│   └── report-web/      React SPA (Vite) for viewing reports, served by the CLI's report server
```

**High-level flow:**

```text
User writes YAML test     CLI parses & validates     Device is prepared
  (.finalrun/tests/)   ──────────────────────────>  (connect, install, launch)
                                                           │
                                                           v
Report displayed        Artifacts saved to disk      AI executes test on device
  (HTML in browser)  <──────────────────────────  (screenshot → LLM → tap/type → repeat)
```

### Why 7 packages?

| Package | Reason for separation |
|---------|----------------------|
| `common` | Types shared by all packages. Changing a type here forces all consumers to stay in sync. |
| `cli` | User-facing. Handles I/O, config, orchestration. Should not know about gRPC or LLM internals. |
| `goal-executor` | The AI loop is complex enough to deserve isolation. It could theoretically be swapped for a different execution strategy. |
| `device-node` | Platform-specific (Android/iOS) device code. Isolates gRPC, ADB, and driver concerns from business logic. |
| `cloud-core` | Pure cloud-submission logic kept free of CLI I/O, so it can be bundled into the compiled CLI binary. |
| `local-runtime` | Builds the per-platform runtime asset tarball (driver APKs/iOS zips, gRPC proto, report SPA dist) the compiled CLI needs at runtime. |
| `report-web` | React SPA (Vite) frontend that the CLI's report server serves. Its Vite bundle is copied into `cli/dist/report-app` at build time (`copyReportApp.mjs`) and into the runtime tarball (`buildRuntimeTarball.mjs`) — both builds fail without it, so it is a build-time dependency of the CLI, not an optional alternative. |

---

## 2. What the User Writes (Input YAML Files)

Before any code runs, the user sets up a workspace:

```text
my-app-repo/
├── .finalrun/
│   ├── config.yaml          # Workspace config (app identity, defaults)
│   ├── tests/               # Test definitions (one YAML per test)
│   │   ├── auth/
│   │   │   ├── login.yaml
│   │   │   └── signup.yaml
│   │   └── checkout/
│   │       └── guest-checkout.yaml
│   ├── suites/              # Suite manifests (group tests together)
│   │   └── smoke.yaml
│   └── env/                 # Environment configs (secrets, variables, app overrides)
│       ├── dev.yaml
│       └── staging.yaml
```

### 2.1 Test YAML (`.finalrun/tests/auth/login.yaml`)

```yaml
name: User Login Flow
description: Verify login with valid credentials

setup:                              # Pre-conditions (run before steps)
  - Launch the app
  - Navigate to login screen

steps:                              # Main test actions (required, non-empty)
  - Enter ${secrets.email} in the email field
  - Enter ${secrets.password} in the password field
  - Tap the Login button

expected_state:                     # Expected outcomes (verified after steps)
  - Dashboard screen is visible
  - Welcome message shows user name
```

**Why this structure?** The `setup → steps → expected_state` pattern mirrors how QA engineers think:
- **setup**: Get the app into the right state
- **steps**: Perform the user actions being tested
- **expected_state**: Verify the outcome

`${secrets.email}` and `${variables.language}` are **binding references** — they get resolved from the environment config at runtime. This lets the same test run against different environments.

### 2.2 Suite YAML (`.finalrun/suites/smoke.yaml`)

```yaml
name: Smoke Suite
description: Quick validation of critical paths

tests:                              # References to test files (relative to .finalrun/tests/)
  - auth/login.yaml
  - auth/signup.yaml
  - checkout/guest-checkout.yaml
```

**Why suites?** Running `finalrun test auth/login.yaml auth/signup.yaml checkout/guest-checkout.yaml` every time is tedious. A suite groups related tests and gives them a name. The suite's `tests:` array contains **selectors** — file paths or glob patterns that resolve to test files.

**Scenario: Suite vs Direct**
```bash
# Direct: run specific tests
finalrun test auth/login.yaml checkout/guest-checkout.yaml

# Suite: run a named group
finalrun suite smoke.yaml
```

Both paths converge to the same execution pipeline — the only difference is how tests are selected.

### 2.3 Environment YAML (`.finalrun/env/dev.yaml`)

```yaml
app:                                # Override app identity per environment
  packageName: org.wikipedia.beta   # Android package (different from production)

secrets:                            # Values read from actual environment variables
  email: ${FINALRUN_TEST_EMAIL}     # Must be ${ENV_VAR_NAME} format exactly
  password: ${FINALRUN_TEST_PASSWORD}

variables:                          # Literal values (string, number, boolean)
  language: Spanish
  timeout: 30
  debug_mode: true
```

**Why separate from tests?** Secrets should never be in YAML files. The `${FINALRUN_TEST_EMAIL}` syntax is a **placeholder** — at runtime, FinalRun reads the actual value from the process environment. This means:
- Tests are portable across environments (dev/staging/prod)
- Secrets never touch the filesystem
- Variables allow the same test to verify different locales, feature flags, etc.

### 2.4 Workspace Config (`.finalrun/config.yaml`)

```yaml
env: dev                            # Default environment (when --env not specified)
app:
  name: Wikipedia
  packageName: org.wikipedia        # Android identifier
  bundleId: org.wikipedia.ios       # iOS identifier
```

**Why?** This is the "base" app identity. Environment configs can override it (e.g., `org.wikipedia.beta` for dev). At least one of `packageName` or `bundleId` is required so FinalRun knows which app to test.

---

## 3. CLI Entry Point & Command Dispatch

**File:** `packages/cli/bin/finalrun.ts`

The CLI uses `commander` for argument parsing. Here are the key commands:

```text
finalrun test [selectors...]     Run tests directly
finalrun suite <path>            Run a suite
finalrun check [selectors...]    Validate without executing
finalrun runs                    List past runs
finalrun start-server            Start the report server
finalrun doctor                  Check host readiness
```

### The `test` command flow

```bash
finalrun test auth/login.yaml --env staging --platform android --model openai/gpt-5.4-mini
```

**What happens in `runTestCommand()` (bin/finalrun.ts:372-485):**

```text
1. normalizeTestSelectors()     Split comma-separated selectors, trim whitespace
2. resolveWorkspace()           Walk up directory tree to find .finalrun/
3. loadWorkspaceConfig()        Read .finalrun/config.yaml
4. parseModel()                 Parse "openai/gpt-5.4-mini" → { provider: "openai", modelName: "gpt-5.4-mini" }
5. resolveEnvironmentFile()     Find the right .finalrun/env/*.yaml
6. CliEnv.load()                Merge .env files + process.env
7. resolveApiKey()              Get OPENAI_API_KEY (or equivalent) from env
8. runTests()                   ← This is where the real work begins
9. startReportServer()          Start/reuse HTTP server for report viewing
10. openBrowser()               Open the run report URL
11. process.exit()              Exit with 0 (pass) or 1 (fail)
```

**Why this order?** Each step validates prerequisites for the next:
- Can't load config without a workspace
- Can't resolve environment without config defaults
- Can't get API key without knowing the provider
- Can't run tests without all of the above

---

## 4. Phase 1: Validation (`runCheck`)

**File:** `packages/common/src/checkRunner.ts`

Before touching any device, FinalRun validates everything:

```text
runCheck()
  │
  ├── resolveRunTarget()
  │   ├── Direct: use CLI selectors as-is
  │   └── Suite: loadTestSuite() → extract suite.tests as selectors
  │
  ├── selectTestFiles(testsDir, selectors)
  │   ├── Expand each selector (file path, directory, or glob)
  │   ├── Match against all .yaml files in .finalrun/tests/
  │   └── Return list of absolute file paths
  │
  ├── For each file: loadTest()
  │   ├── Parse YAML
  │   ├── Validate required fields (name, steps)
  │   ├── Compute testId from relative path ("auth/login.yaml" → "auth-login")
  │   └── Return TestDefinition
  │
  ├── For each test: validateTestBindings()
  │   ├── Scan for ${variables.*} and ${secrets.*} references
  │   └── Verify all referenced names exist in environment config
  │
  ├── resolveAppConfig()
  │   ├── Environment app config overrides workspace config
  │   └── Determine platform from identifiers (packageName → android, bundleId → ios)
  │
  └── Return CheckRunnerResult {
        workspace, environment, tests[], target, suite?, resolvedApp
      }
```

**Scenario: What happens when a binding is missing?**
```yaml
# Test references ${secrets.api_key}
# But dev.yaml only defines:
secrets:
  email: ${FINALRUN_TEST_EMAIL}
```
→ `validateTestBindings()` throws: `Test "login" references secret "api_key" which is not defined in environment "dev"`

**Why validate before execution?** Device setup takes 30-60 seconds. Catching a typo in a YAML reference before that saves significant time.

---

## 5. Phase 2: Device Setup (`prepareTestSession`)

**File:** `packages/cli/src/sessionRunner.ts`

```text
prepareTestSession()
  │
  ├── DeviceNode.detectInventory()
  │   ├── Run `adb devices -l` (Android)
  │   ├── Run `xcrun simctl list devices` (iOS)
  │   └── Return list of connected/available devices
  │
  ├── Filter by requested platform
  │   └── If multiple devices: prompt user to choose
  │
  ├── DeviceNode.setUpDevice(deviceInfo)
  │   │
  │   ├── [Android] AndroidDeviceSetup:
  │   │   ├── Install driver APK (app.finalrun.android)
  │   │   ├── Install test runner APK (app.finalrun.android.test)
  │   │   ├── Forward port: localhost:PORT → device:GRPC_PORT
  │   │   ├── Start driver via ADB instrumentation
  │   │   ├── Poll gRPC ping (up to 120s, 240 attempts × 500ms)
  │   │   └── Wait for UiAutomation readiness (15s)
  │   │
  │   └── [iOS] IOSSimulatorSetup:
  │       ├── Install driver on simulator
  │       ├── Start driver process
  │       └── Poll gRPC connection
  │
  ├── ensureAppReady()
  │   ├── Get installed app list via gRPC
  │   ├── Verify target app is installed
  │   ├── Launch app with LaunchAppAction
  │   └── Return launch summary
  │
  └── Return TestSession {
        device, deviceInfo, platform, app, cleanup()
      }
```

**Why gRPC?** FinalRun installs a small driver app on the device that exposes a gRPC server. The host machine connects to it via port forwarding. gRPC is used because:
- It's strongly typed (proto definitions)
- It supports streaming (for screenshots)
- It's efficient for binary data (screenshot bytes)

**Scenario: "Already connected" error**
During UiAutomation readiness polling, the driver may return "Already connected" — this is a **transient** state during Android's UiAutomation framework initialization. FinalRun classifies this as retryable (see `TRANSIENT_CAPTURE_PATTERNS` in `ScreenshotCapture.ts`).

**Why poll for 120s?** Android emulators can take a long time to start the instrumentation framework, especially on slower machines. The generous timeout prevents false failures.

---

## 6. Phase 3: Test Execution Loop

**File:** `packages/cli/src/testRunner.ts`

This is the main orchestrator. Tests run **sequentially** (no parallelism):

```text
runTests()
  │
  ├── runCheck()                    ← Phase 1 (validation)
  ├── runHostPreflight()            ← Check SDK tools
  ├── prepareTestSession()          ← Phase 2 (device setup)
  │
  ├── FOR EACH test in tests[]:     ← Sequential loop
  │   │
  │   ├── [First iteration] Create ReportWriter
  │   │   └── Generate runId: "2026-04-04T05-25-34.256Z-dev-android"
  │   │   └── Create run directory under artifacts/
  │   │   └── Initialize runner.log
  │   │
  │   ├── reportWriter.writeRunInputs()
  │   │   └── Snapshot all test YAMLs, env config, suite config to disk
  │   │
  │   ├── compileTestObjective(test, bindings)
  │   │   └── Interpolate variables, format as AI prompt
  │   │
  │   ├── executeTestOnSession(session, config)    ← The AI execution
  │   │   ├── Create AIAgent (LLM client)
  │   │   ├── Create TestExecutor (goal-executor)
  │   │   ├── Start device recording (.mp4)
  │   │   ├── executor.executeGoal()               ← See Section 7
  │   │   ├── Stop recording
  │   │   └── Return TestExecutionResult
  │   │
  │   ├── reportWriter.writeTestRecord()           ← See Section 9
  │   │   └── Write screenshots, step JSONs, result.json
  │   │
  │   └── Check: should we stop?
  │       ├── Aborted (Ctrl+C) → break
  │       └── Terminal failure → break
  │
  ├── reportWriter.finalize()
  │   ├── Write summary.json
  │   ├── Write run.json (the main manifest)
  │   └── rebuildRunIndex() → update runs.json
  │
  └── Return TestRunnerResult { success, runDir, serverUrl }
```

**Why sequential?** Each test runs on the same physical device. Parallel execution would require multiple devices or complex state management. Sequential is simpler and more reliable.

**Why create ReportWriter on first iteration?** If validation fails before any test runs, there's no need to create an artifacts directory. This avoids empty run directories.

**SIGINT handling:** First Ctrl+C sets an abort flag (current test finishes gracefully). Second Ctrl+C forces exit. This prevents data corruption in artifacts.

---

## 7. The Goal Executor (AI Brain)

**Package:** `packages/goal-executor/src/`

This is where the AI magic happens. The goal executor implements a loop:
**capture → plan → act → repeat until done.**

### 7.1 The Core Loop (`TestExecutor.executeGoal`)

**File:** `packages/goal-executor/src/TestExecutor.ts`

```text
executeGoal(goal, onProgress?)
  │
  FOR iteration = 1 to maxIterations:
  │
  ├── 1. CAPTURE: Get device state
  │   └── device.executeAction(GetScreenshotAndHierarchyAction)
  │   └── Returns: { screenshot (base64 JPEG), hierarchy (UI tree JSON) }
  │
  ├── 2. PLAN: Ask AI what to do next
  │   └── aiAgent.plan({
  │         goal,              # "User Login Flow: Enter email, tap login..."
  │         screenshot,        # Current screen image
  │         hierarchy,         # UI element tree (text, bounds, scrollable, etc.)
  │         history,           # "1. [tap] Tapped login → SUCCESS\n2. [type]..."
  │         appContext          # Optional app knowledge
  │       })
  │   └── Returns PlannerResponse:
  │       {
  │         act: "tap" | "type" | "scroll" | "completed" | "failed" | ...,
  │         reason: "The login button is visible in the top right",
  │         text: "user@example.com",     # for type actions
  │         direction: "down",             # for scroll actions
  │         remember: "Already entered email, need to enter password next"
  │       }
  │
  ├── 3. CHECK: Is the test done?
  │   ├── act === "completed" → return { success: true, analysis: reason }
  │   └── act === "failed"    → return { success: false, analysis: reason }
  │
  ├── 4. ACT: Execute the planned action
  │   └── ActionExecutor.executeAction({action, reason, params})
  │       │
  │       ├── For TAP / LONG_PRESS:
  │       │   ├── aiAgent.ground() → find element coordinates from hierarchy
  │       │   │   └── If hierarchy insufficient: VisualGrounder (screenshot-only)
  │       │   └── device.tap(x, y)
  │       │
  │       ├── For TYPE:
  │       │   ├── aiAgent.ground() → find input field
  │       │   ├── device.tap(field) → focus it
  │       │   └── device.enterText(value)
  │       │
  │       ├── For SCROLL:
  │       │   ├── aiAgent.ground() → determine scroll vector
  │       │   └── device.scrollAbs(startX, startY, endX, endY)
  │       │
  │       └── For BACK / HOME / ROTATE / WAIT:
  │           └── device.executeAction() → simple, no grounding needed
  │
  ├── 5. POST-CAPTURE: Screenshot after action
  │   └── Stored for next planning iteration
  │
  └── 6. BUILD HISTORY: Add to running log
      └── "3. [tap] Tapped login button → SUCCESS"
      └── Continue to next iteration
```

### 7.2 The Two-Phase AI Call

**Why two separate LLM calls (plan + ground)?**

```text
Plan:   "What should I do?"    → "Tap the Login button"     (high-level reasoning)
Ground: "Where exactly is it?" → coordinates (312, 847)      (precise location)
```

Separating these concerns means:
- The **planner** focuses on understanding the test goal and choosing actions
- The **grounder** focuses on mapping "Login button" to pixel coordinates using the UI hierarchy
- If the hierarchy doesn't contain the element (e.g., it's a custom-rendered widget), the **VisualGrounder** falls back to screenshot-only grounding

### 7.3 Grounding Strategies

```text
Standard Grounder (hierarchy-based)
  │ Input: action description + screenshot + UI hierarchy
  │ Output: element index → converted to (x, y) coordinates
  │
  │ If element not in hierarchy:
  └──→ VisualGrounder (screenshot-only fallback)
       │ Input: action description + screenshot (no hierarchy)
       │ Output: (x, y) coordinates directly from visual analysis
```

**Why hierarchy first?** The UI hierarchy is structured data — it's faster and more reliable than visual analysis. But some UI elements (custom Canvas widgets, game views) don't appear in the hierarchy, so the visual fallback exists.

### 7.4 Supported Action Types

| Action | What it does | Needs grounding? |
|--------|-------------|-----------------|
| `tap` | Tap a UI element | Yes (where to tap) |
| `longPress` | Long press a UI element | Yes |
| `type` | Enter text in a field | Yes (which field) |
| `scroll` | Scroll in a direction | Yes (scroll region + vector) |
| `back` | Press back button | No |
| `home` | Press home button | No |
| `rotate` | Rotate device | No |
| `hideKeyboard` | Dismiss keyboard | No |
| `launchApp` | Launch an app | Yes (which app from list) |
| `deeplink` | Open a URL/deeplink | No |
| `setLocation` | Set GPS coordinates | Yes (which coordinates) |
| `wait` | Wait/do nothing | No |
| `completed` | Test passed (terminal) | N/A |
| `failed` | Test failed (terminal) | N/A |

### 7.5 LLM Provider Support

```typescript
// AIAgent supports three providers via Vercel AI SDK:
- OpenAI     (gpt-5.4-mini, with reasoning effort)
- Google     (Gemini, with thinking levels)
- Anthropic  (Claude, with extended thinking)
```

**Why Vercel AI SDK?** It provides a unified interface across providers, so the goal executor doesn't need provider-specific code for each LLM.

Model and reasoning effort are configurable per feature (planner, grounder, and the specialized grounders) via the `features:` block in `.finalrun/config.yaml`. See [configuration.md](configuration.md) for the YAML shape.

---

## 8. The Device Layer (Physical Actions)

**Package:** `packages/device-node/src/`

### 8.1 Architecture

```text
DeviceNode (singleton)
  │
  ├── DeviceDiscoveryService     Detect connected devices (ADB / simctl)
  ├── DevicePool                 Store active Device instances
  └── GrpcDriverSetup            Install driver, establish gRPC connection
       │
       └── Device (implements DeviceAgent)
            │
            ├── AndroidDevice (DeviceRuntime)
            │   ├── CommonDriverActions (shared gRPC calls)
            │   │   └── ScreenshotCaptureCoordinator
            │   │       └── ScreenshotCaptureHelper
            │   └── AdbClient (ADB shell commands)
            │
            └── IOSSimulator (DeviceRuntime)
                ├── CommonDriverActions
                └── SimctlClient
```

### 8.2 How a Tap Gets to the Device

```text
goal-executor calls device.executeAction(TapAction(312, 847))
    │
    v
Device.executeAction() routes to runtime.tap()
    │
    v
AndroidDevice.tap() delegates to commonDriverActions.tap()
    │
    v
CommonDriverActions calls grpcClient.tap({x: 312, y: 847})
    │
    v
GrpcDriverClient sends gRPC request over forwarded port
    │
    v
On-device driver (APK) receives request
    │
    v
UiAutomation framework injects touch event at (312, 847)
    │
    v
App processes the tap as if a real user touched the screen
```

### 8.3 Screenshot Capture (with stability + retry)

**File:** `packages/device-node/src/device/ScreenshotCapture.ts`

```text
capture()
  │
  ├── Phase 1: STABILITY WAIT (optional)
  │   │ Why? After a tap, the UI may be animating. Capturing mid-animation
  │   │ gives the AI a blurry/transitional screenshot that leads to bad decisions.
  │   │
  │   └── Poll raw screenshots every 300ms
  │       ├── Hash each screenshot (SHA1)
  │       ├── When 2 consecutive hashes match → screen is stable
  │       └── Timeout: 5000ms (continue anyway if not stable)
  │
  └── Phase 2: FINAL CAPTURE (with retry)
      │ Why? The gRPC call can fail transiently (UiAutomation reconnecting,
      │ device under load, etc.)
      │
      ├── Call grpcClient.getScreenshotAndHierarchy()
      ├── Validate: non-empty screenshot, valid hierarchy JSON
      ├── If transient error: retry (up to 3 attempts, 300ms between)
      └── Return { screenshot, hierarchy, dimensions, traceMetadata }
```

**Transient error patterns (retry these):**
- `"uiautomation not connected"` — framework restarting
- `"already connected"` — transitional state during init
- `"unavailable"` — gRPC channel temporarily down
- `"empty screenshot"` — driver returned blank image
- `"missing hierarchy"` — hierarchy not ready yet

### 8.4 Device Session Lifecycle

```text
1. DETECTION:  DeviceNode.detectInventory()     → list of devices
2. SELECTION:  User picks a device (or auto-select if only one)
3. SETUP:      DeviceNode.setUpDevice()          → install driver, connect gRPC
4. READINESS:  waitForDriverCaptureReadiness()   → verify screenshot works
5. EXECUTION:  device.executeAction() (repeated) → tap, type, scroll, capture
6. CLEANUP:    device.closeConnection()          → remove port forward, kill driver
```

---

## 9. Phase 4: Artifact Writing

**File:** `packages/cli/src/reportWriter.ts`

### 9.1 What Gets Written to Disk

After each test completes, `reportWriter.writeTestRecord()` persists everything:

```text
artifacts/{runId}/
├── runner.log                      # Timestamped execution log
├── run.json                        # Complete run manifest (schema v2)
├── summary.json                    # Quick summary with counts
├── input/
│   ├── run-context.json            # CLI command, model, app config
│   ├── env.snapshot.yaml           # Frozen copy of environment config
│   ├── env.json                    # Redacted environment (secrets masked)
│   ├── suite.snapshot.yaml         # Frozen copy of suite (if applicable)
│   ├── suite.json                  # Suite as JSON
│   └── tests/
│       ├── {testId}.yaml           # Frozen copy of each test definition
│       └── {testId}.json           # Test definition as JSON
└── tests/
    └── {testId}/
        ├── result.json             # Test execution result
        ├── recording.mp4           # Screen recording (Android)
        ├── actions/
        │   ├── 001.json            # Step 1 details (action, timing, trace)
        │   ├── 002.json            # Step 2 details
        │   └── ...
        └── screenshots/
            ├── 001.jpg             # Screenshot after step 1
            ├── 002.jpg             # Screenshot after step 2
            └── ...
```

### 9.2 Why Snapshot Inputs?

The `input/` directory freezes the state of all inputs at execution time. This is critical because:
- The user might edit `login.yaml` after a run — the snapshot preserves what was actually tested
- Environment variables change between runs — the snapshot captures what was bound
- Suite definitions evolve — the snapshot shows exactly which tests were selected

### 9.3 Secret Redaction

**Why?** Artifacts are stored on disk and displayed in HTML reports. Secrets must never appear in plain text.

```typescript
// reportWriter redacts secrets before writing:
// Input:  "Entered password123 in field"
// Output: "Entered [REDACTED] in field"
```

The `RuntimeBindings.secrets` map is used to find and replace secret values in all written artifacts.

### 9.4 The Finalization Step

After all tests complete, `reportWriter.finalize()` writes the two summary files:

1. **`summary.json`** — Quick stats (counts, duration, first failure)
2. **`run.json`** — The complete `RunManifest` with everything: inputs, test results, steps, paths

Then `rebuildRunIndex()` scans all run directories and regenerates `runs.json` — the global index of all runs.

---

## 10. Phase 5: Report Server & Display

### 10.1 Two Report Server Implementations

FinalRun has two ways to display reports:

| | Built-in Server (`cli`) | React SPA (`report-web`) |
|---|---|---|
| **File** | `packages/cli/src/reportServer.ts` | `packages/report-web/` |
| **Technology** | Raw `http.createServer()` | Vite + React SPA |
| **When used** | Default (`finalrun start-server`) | Development or custom deploy |
| **Routes** | Same | Same |

Both serve the same routes with the same data:

```text
GET /                           → Run index page (list of all runs)
GET /runs/{runId}               → Individual run detail page
GET /artifacts/{path}           → Raw artifact files (screenshots, videos, logs)
GET /health                     → Server health check
```

### 10.2 How the Server Starts

```text
After test completes:
  │
  ├── startOrReuseWorkspaceReportServer()
  │   ├── Check for existing .server.json in artifacts dir
  │   ├── If exists: ping /health endpoint
  │   │   ├── If healthy + same workspace: reuse existing server
  │   │   └── If unhealthy or wrong workspace: start new server
  │   └── If not exists: start new server
  │
  ├── Start new server:
  │   ├── Find available port near 4178
  │   ├── Spawn `finalrun internal-report-server` as detached process
  │   ├── Wait for /health to respond (up to 30s)
  │   └── Write .server.json with PID, port, workspace paths
  │
  └── Open browser to http://127.0.0.1:4178/runs/{runId}
```

**Why detached process?** The report server must outlive the CLI process. After `finalrun test` exits, the user should still be able to browse the report.

**Why health check with workspace validation?** A stale server from a different workspace could serve wrong artifacts. The health check verifies the server is serving the right workspace.

### 10.3 The View Model Layer

Raw `RunManifest` data from disk gets enriched before rendering:

```text
Raw Data (run.json)                    View Model (for HTML)
─────────────────                      ─────────────────────
runId: "2026-04-..."          →        displayName: "Smoke Suite"
target.type: "suite"          →        displayKind: "suite"
target.suiteName: "Smoke"     →        triggeredFrom: "Suite"
input.tests.length: 3         →        selectedTestCount: 3
snapshotYamlPath: "input/..." →        snapshotYamlText: "name: login\nsteps:..."
paths.log: "runner.log"       →        paths.log: "/artifacts/{runId}/runner.log"
```

**Display name derivation logic:**
```text
Suite run?           → Use suite name ("Smoke Suite")
1 test selected?     → Use test name ("User Login Flow")
N tests selected?    → First test name + count ("User Login Flow +2 more")
No tests (failure)?  → Use runId as fallback
```

### 10.4 Artifact Serving with Byte Ranges

**Why byte ranges?** Video recordings can be large (50MB+). Browsers need byte-range support to seek within videos without downloading the entire file.

```text
Browser: GET /artifacts/runs/clip.mp4
         Range: bytes=1000000-2000000

Server:  HTTP/1.1 206 Partial Content
         Content-Range: bytes 1000000-2000000/50000000
         Content-Length: 1000001
         [1MB of video data]
```

---

## 11. Complete Data Flow Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         USER INPUT                                  │
│  .finalrun/config.yaml    .finalrun/tests/*.yaml    .finalrun/env/  │
│  .finalrun/suites/*.yaml                                            │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 v
┌─────────────────────────────────────────────────────────────────────┐
│                    CLI (packages/cli/)                               │
│                                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌────────────┐  │
│  │ Workspace │──>│ Check    │──>│ Test Runner   │──>│ Report     │  │
│  │ Resolver  │   │ Runner   │   │ (sequential)  │   │ Writer     │  │
│  └──────────┘   └──────────┘   └──────┬───────┘   └─────┬──────┘  │
│                                        │                  │         │
└────────────────────────────────────────┼──────────────────┼─────────┘
                                         │                  │
                    ┌────────────────────┘                  │
                    v                                       v
┌──────────────────────────────┐    ┌─────────────────────────────────┐
│  Goal Executor               │    │  Artifacts on Disk              │
│  (packages/goal-executor/)   │    │                                 │
│                              │    │  artifacts/{runId}/             │
│  ┌─────────┐  ┌───────────┐ │    │  ├── run.json                  │
│  │ AI Agent │  │ Action    │ │    │  ├── runner.log                │
│  │ (LLM)   │  │ Executor  │ │    │  ├── input/tests/*.yaml        │
│  └────┬────┘  └─────┬─────┘ │    │  └── tests/{testId}/           │
│       │              │       │    │      ├── result.json            │
│       │      plan    │  act  │    │      ├── recording.mp4         │
│       └──────────────┘       │    │      ├── actions/001.json      │
│              │               │    │      └── screenshots/001.jpg   │
└──────────────┼───────────────┘    └──────────────┬──────────────────┘
               │                                    │
               v                                    v
┌──────────────────────────────┐    ┌─────────────────────────────────┐
│  Device Node                 │    │  Report Server                  │
│  (packages/device-node/)     │    │  (packages/cli/ or report-web/) │
│                              │    │                                 │
│  ┌─────────┐  ┌───────────┐ │    │  GET /                → Index   │
│  │ gRPC    │  │ ADB/      │ │    │  GET /runs/{id}       → Detail  │
│  │ Client  │  │ Simctl    │ │    │  GET /artifacts/{..}  → Files   │
│  └────┬────┘  └─────┬─────┘ │    │                                 │
│       │              │       │    │       ┌───────────┐             │
│       └──────┬───────┘       │    │       │  Browser  │             │
│              │               │    │       └───────────┘             │
└──────────────┼───────────────┘    └─────────────────────────────────┘
               │
               v
┌──────────────────────────────┐
│  Physical Device             │
│  (Android emulator/device    │
│   or iOS simulator)          │
│                              │
│  ┌─────────────────────────┐ │
│  │ FinalRun Driver (APK)   │ │
│  │ gRPC server on device   │ │
│  │ UiAutomation framework  │ │
│  └─────────────────────────┘ │
└──────────────────────────────┘
```

---

## 12. JSON Artifacts Reference

### 12.1 `run.json` (RunManifest — the master record)

This is the most important artifact. It contains everything about a run.

```json
{
  "schemaVersion": 2,
  "run": {
    "runId": "2026-04-04T05-25-34.256Z-dev-android",
    "success": false,
    "status": "failure",
    "failurePhase": "execution",
    "startedAt": "2026-04-04T05:25:34.256Z",
    "completedAt": "2026-04-04T05:26:44.256Z",
    "durationMs": 70000,
    "envName": "dev",
    "platform": "android",
    "model": {
      "provider": "openai",
      "modelName": "gpt-5.4-mini",
      "label": "openai/gpt-5.4-mini"
    },
    "app": {
      "source": "repo",
      "label": "repo app",
      "identifier": "org.wikipedia",
      "identifierKind": "packageName",
      "name": "Wikipedia"
    },
    "selectors": [],
    "target": {
      "type": "suite",
      "suiteId": "smoke",
      "suiteName": "Smoke Suite",
      "suitePath": "smoke.yaml"
    },
    "counts": {
      "tests": { "total": 2, "passed": 1, "failed": 1 },
      "steps": { "total": 8, "passed": 7, "failed": 1 }
    },
    "firstFailure": {
      "testId": "auth-login",
      "testName": "User Login Flow",
      "stepNumber": 4,
      "actionType": "tap",
      "message": "Login button not found after entering credentials",
      "screenshotPath": "tests/auth-login/screenshots/004.jpg",
      "stepJsonPath": "tests/auth-login/actions/004.json"
    }
  },
  "input": {
    "environment": {
      "envName": "dev",
      "variables": { "language": "Spanish" },
      "secretReferences": [
        { "key": "email", "envVar": "FINALRUN_TEST_EMAIL" }
      ]
    },
    "suite": {
      "suiteId": "smoke",
      "name": "Smoke Suite",
      "workspaceSourcePath": ".finalrun/suites/smoke.yaml",
      "snapshotYamlPath": "input/suite.snapshot.yaml",
      "snapshotJsonPath": "input/suite.json",
      "tests": ["auth/login.yaml", "checkout/guest-checkout.yaml"],
      "resolvedTestIds": ["auth-login", "checkout-guest-checkout"]
    },
    "tests": [
      {
        "testId": "auth-login",
        "name": "User Login Flow",
        "relativePath": "auth/login.yaml",
        "workspaceSourcePath": ".finalrun/tests/auth/login.yaml",
        "snapshotYamlPath": "input/tests/auth-login.yaml",
        "snapshotJsonPath": "input/tests/auth-login.json",
        "bindingReferences": {
          "variables": ["language"],
          "secrets": ["email", "password"]
        },
        "setup": ["Launch the app"],
        "steps": ["Enter ${secrets.email} in email field", "Tap Login"],
        "expected_state": ["Dashboard is visible"]
      }
    ],
    "cli": {
      "command": "finalrun suite smoke.yaml --env dev",
      "selectors": [],
      "suitePath": "smoke.yaml",
      "debug": false
    }
  },
  "tests": [
    {
      "testId": "auth-login",
      "testName": "User Login Flow",
      "sourcePath": "/repo/.finalrun/tests/auth/login.yaml",
      "relativePath": "auth/login.yaml",
      "success": false,
      "status": "failure",
      "message": "Login button not found after entering credentials",
      "analysis": "The login button was obscured by the keyboard.",
      "platform": "android",
      "startedAt": "2026-04-04T05:25:40.000Z",
      "completedAt": "2026-04-04T05:26:10.000Z",
      "durationMs": 30000,
      "recordingFile": "tests/auth-login/recording.mp4",
      "recordingStartedAt": "2026-04-04T05:25:40.000Z",
      "recordingCompletedAt": "2026-04-04T05:26:10.000Z",
      "snapshotYamlPath": "input/tests/auth-login.yaml",
      "resultJsonPath": "tests/auth-login/result.json",
      "previewScreenshotPath": "tests/auth-login/screenshots/004.jpg",
      "counts": {
        "executionStepsTotal": 4,
        "executionStepsPassed": 3,
        "executionStepsFailed": 1
      },
      "firstFailure": {
        "testId": "auth-login",
        "testName": "User Login Flow",
        "stepNumber": 4,
        "actionType": "tap",
        "message": "Login button not found"
      },
      "steps": [
        {
          "stepNumber": 1,
          "iteration": 1,
          "actionType": "tap",
          "naturalLanguageAction": "Tap the email field",
          "reason": "Need to focus the email input before typing",
          "success": true,
          "status": "success",
          "durationMs": 2500,
          "timestamp": "2026-04-04T05:25:42.000Z",
          "screenshotFile": "tests/auth-login/screenshots/001.jpg",
          "videoOffsetMs": 2000,
          "stepJsonFile": "tests/auth-login/actions/001.json",
          "trace": {
            "step": 1,
            "action": "tap",
            "status": "success",
            "totalMs": 2500,
            "spans": [
              { "name": "capture", "startMs": 0, "durationMs": 800, "status": "success" },
              { "name": "plan", "startMs": 800, "durationMs": 1200, "status": "success" },
              { "name": "ground", "startMs": 2000, "durationMs": 300, "status": "success" },
              { "name": "execute", "startMs": 2300, "durationMs": 200, "status": "success" }
            ]
          }
        }
      ]
    }
  ],
  "paths": {
    "runJson": "run.json",
    "summaryJson": "summary.json",
    "log": "runner.log",
    "runContextJson": "input/run-context.json"
  }
}
```

### 12.2 `runs.json` (RunIndex — the global index)

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-04T05:27:00.000Z",
  "runs": [
    {
      "runId": "2026-04-04T05-25-34.256Z-dev-android",
      "success": false,
      "status": "failure",
      "startedAt": "2026-04-04T05:25:34.256Z",
      "completedAt": "2026-04-04T05:26:44.256Z",
      "durationMs": 70000,
      "envName": "dev",
      "platform": "android",
      "modelLabel": "openai/gpt-5.4-mini",
      "appLabel": "repo app",
      "target": {
        "type": "suite",
        "suiteId": "smoke",
        "suiteName": "Smoke Suite",
        "suitePath": "smoke.yaml"
      },
      "testCount": 2,
      "passedCount": 1,
      "failedCount": 1,
      "stepCount": 8,
      "firstFailure": {
        "testId": "auth-login",
        "testName": "User Login Flow",
        "stepNumber": 4,
        "actionType": "tap",
        "message": "Login button not found"
      },
      "previewScreenshotPath": "2026-04-04T05-25-34.256Z-dev-android/tests/auth-login/screenshots/004.jpg",
      "paths": {
        "runJson": "2026-04-04T05-25-34.256Z-dev-android/run.json",
        "log": "2026-04-04T05-25-34.256Z-dev-android/runner.log"
      }
    }
  ]
}
```

### 12.3 Per-Step Action JSON (`tests/{testId}/actions/001.json`)

```json
{
  "stepNumber": 1,
  "iteration": 1,
  "actionType": "tap",
  "naturalLanguageAction": "Tap the email field",
  "reason": "Need to focus the email input before typing",
  "thought": {
    "plan": "Enter the email address first, then the password",
    "think": "The email field is visible at the top of the login form",
    "act": "Tap the email input field to focus it"
  },
  "actionPayload": {
    "repeat": 1
  },
  "success": true,
  "status": "success",
  "durationMs": 2500,
  "timestamp": "2026-04-04T05:25:42.000Z",
  "screenshotFile": "tests/auth-login/screenshots/001.jpg",
  "videoOffsetMs": 2000,
  "stepJsonFile": "tests/auth-login/actions/001.json",
  "trace": {
    "step": 1,
    "action": "tap",
    "status": "success",
    "totalMs": 2500,
    "spans": [
      { "name": "capture", "startMs": 0, "durationMs": 800, "status": "success" },
      { "name": "plan", "startMs": 800, "durationMs": 1200, "status": "success" },
      { "name": "ground", "startMs": 2000, "durationMs": 300, "status": "success" },
      { "name": "execute", "startMs": 2300, "durationMs": 200, "status": "success" }
    ]
  },
  "timing": {
    "totalMs": 2500,
    "spans": [
      { "name": "capture", "durationMs": 800, "status": "success" },
      { "name": "plan", "durationMs": 1200, "status": "success" },
      { "name": "ground", "durationMs": 300, "status": "success" },
      { "name": "execute", "durationMs": 200, "status": "success" }
    ]
  }
}
```

---

## 13. Package Map

Quick reference: where to find what.

### `packages/common/src/models/`

| File | What it defines | Why it exists |
|------|----------------|---------------|
| `RunManifest.ts` | `RunManifest`, `RunTarget`, `RunStatus`, `FailurePhase` | The master contract for run artifacts |
| `RunIndex.ts` | `RunIndex`, `RunIndexEntry` | The index file contract |
| `TestDefinition.ts` | `TestDefinition`, `BindingReference` | What a test looks like after YAML parsing |
| `TestResult.ts` | `TestResult`, `AgentAction`, `FirstFailure`, `TestStatus` | What a test result looks like after execution |
| `SuiteDefinition.ts` | `SuiteDefinition` | What a suite looks like after YAML parsing |
| `DeviceAction.ts` | `TapAction`, `EnterTextAction`, `ScrollAbsAction`, ... (22 concrete action classes) | All possible device actions |
| `Environment.ts` | `AppConfig`, `EnvironmentConfig`, `RuntimeBindings` | Environment and binding types |
| `Trace.ts` | `AgentActionTrace`, `TraceSpan`, `TimingInfo` | Performance tracing types |
| `Hierarchy.ts` | `Hierarchy`, `HierarchyNode` | UI element tree from device |

### `packages/common/src/` (non-model modules)

| File | What it does | Key functions |
|------|-------------|---------------|
| `checkRunner.ts` | Validation phase | `runCheck()` |
| `testLoader.ts` | YAML file parsing | `loadTest()`, `loadTestSuite()`, `loadEnvironmentConfig()` |
| `testSelection.ts` | Test file discovery | `selectTestFiles()`, `expandSelector()` |
| `workspace.ts` | Workspace discovery | `resolveWorkspace()`, `loadWorkspaceConfig()` |
| `appConfig.ts` | App configuration | `resolveAppConfig()` |
| `env.ts` | Environment variables | `CliEnv` |
| `constants.ts` | Shared constants, model string parsing | `parseModel()`, `parseReasoningLevel()` |

### `packages/cli/bin/`

| File | What it does | Key functions |
|------|-------------|---------------|
| `finalrun.ts` | CLI entry point, command definitions | `runTestCommand()` |

### `packages/cli/src/`

| File | What it does | Key functions |
|------|-------------|---------------|
| `testRunner.ts` | Main test orchestrator | `runTests()` |
| `sessionRunner.ts` | Device setup + test execution | `prepareTestSession()`, `executeTestOnSession()` |
| `testCompiler.ts` | Test → AI prompt | `compileTestObjective()` |
| `apiKey.ts` | API key resolution | `resolveApiKey()` |
| `reportWriter.ts` | Artifact writing | `ReportWriter` class |
| `runIndex.ts` | Run index management | `rebuildRunIndex()`, `loadRunIndex()` |
| `reportServer.ts` | Built-in HTTP server | `serveReportWorkspace()` |
| `reportServerManager.ts` | Server lifecycle | `startOrReuseWorkspaceReportServer()` |
| `hostPreflight.ts` | SDK checks | `runHostPreflight()` |

### `packages/goal-executor/src/`

| File | What it does | Key classes/functions |
|------|-------------|---------------------|
| `TestExecutor.ts` | Main AI loop (capture → plan → act → repeat) | `TestExecutor.executeGoal()` |
| `ActionExecutor.ts` | Routes AI plan to device actions | `ActionExecutor.executeAction()` |
| `ai/AIAgent.ts` | LLM interface (plan + ground) | `AIAgent.plan()`, `AIAgent.ground()` |
| `ai/VisualGrounder.ts` | Screenshot-only fallback grounder | `VisualGrounder.ground()` |
| `ai/providerFailure.ts` | Classify LLM errors as fatal/transient | `isFatalProviderError()` |
| `GrounderResponseConverter.ts` | Parse grounder output → coordinates | `extractPoint()`, `extractScrollAction()` |
| `trace.ts` | Performance tracing | `StepTraceBuilder` |

### `packages/device-node/src/`

| File | What it does | Key classes |
|------|-------------|------------|
| `DeviceNode.ts` | Singleton device manager | `DeviceNode` |
| `device/Device.ts` | Device wrapper (implements DeviceAgent) | `Device` |
| `device/android/AndroidDevice.ts` | Android runtime | `AndroidDevice` |
| `device/ios/IOSSimulator.ts` | iOS runtime | `IOSSimulator` |
| `device/shared/CommonDriverActions.ts` | Shared gRPC actions | `CommonDriverActions` |
| `device/ScreenshotCapture.ts` | Screenshot with stability + retry | `ScreenshotCaptureHelper` |
| `grpc/GrpcDriverClient.ts` | gRPC client | `GrpcDriverClient` |
| `grpc/GrpcDriverSetup.ts` | Driver installation + connection | `GrpcDriverSetup` |
| `grpc/setup/AndroidDeviceSetup.ts` | Android-specific setup | `AndroidDeviceSetup` |
| `infra/android/AdbClient.ts` | ADB command executor | `AdbClient` |
| `discovery/DeviceDiscoveryService.ts` | Device detection | `DeviceDiscoveryService` |
| `device/DevicePool.ts` | In-memory device pool | `DevicePool` |

### `packages/report-web/src/`

| File | What it does | Key functions |
|------|-------------|---------------|
| `artifacts.ts` | View model layer + artifact serving | `loadReportIndexViewModel()`, `loadArtifactResponse()` |
| `renderers.ts` | HTML report rendering | `renderRunIndexHtml()`, `renderRunHtml()` |
| `contentTypes.ts` | MIME type mapping | `REPORT_CONTENT_TYPES` |
| `app/route.ts` | Next.js index route | `GET()` |
| `app/runs/[runId]/route.ts` | Next.js run detail route | `GET()` |
| `app/artifacts/[...artifactPath]/route.ts` | Next.js artifact serving | `GET()`, `HEAD()` |

---

## End-to-End Scenario: Running a Suite

To tie it all together, here's what happens when a user runs:

```bash
FINALRUN_TEST_EMAIL="user@test.com" finalrun suite smoke.yaml --env dev
```

1. **CLI parses** `suite smoke.yaml --env dev` → dispatches to `runTestCommand()`
2. **Workspace found**: walks up to find `.finalrun/` directory
3. **Config loaded**: reads `.finalrun/config.yaml` → gets app identity (`org.wikipedia`)
4. **Environment loaded**: reads `.finalrun/env/dev.yaml` → resolves `${FINALRUN_TEST_EMAIL}` → `"user@test.com"`
5. **Suite loaded**: reads `.finalrun/suites/smoke.yaml` → gets test list `["auth/login.yaml", "checkout/guest.yaml"]`
6. **Tests loaded**: reads each YAML, validates bindings, computes testIds
7. **Host checked**: verifies ADB/Xcode tools are available
8. **Device connected**: detects Android device via `adb devices`, installs driver APK, starts gRPC server, waits for readiness
9. **App launched**: verifies `org.wikipedia` is installed, launches it
10. **Test 1 executes** (`auth/login.yaml`):
    - Recording starts
    - AI loop: capture screen → LLM says "tap email field" → ground to (312, 450) → tap → capture → LLM says "type user@test.com" → type → ... → LLM says "completed"
    - Recording stops
    - Screenshots + step JSONs + result.json written to `tests/auth-login/`
11. **Test 2 executes** (`checkout/guest.yaml`): same process
12. **Finalization**: writes `run.json`, `summary.json`, rebuilds `runs.json`
13. **Report server** starts (or reuses existing) on port 4178
14. **Browser opens** to `http://127.0.0.1:4178/runs/2026-04-04T05-25-34.256Z-dev-android`
15. **CLI exits** with code 0 (all passed) or 1 (any failed)
