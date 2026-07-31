---
type: memory
description: "UI-hierarchy parse contract (`common/src/models/Hierarchy.ts`, consumed by four goal-executor files): `fromJsonString` dispatches array→flat / object→tree, and the paths are deliberately not equivalent — only the flat path shortens `:id/` ids, infers `isImage` from the class, takes `identifier`; alias resolution is `??`-presence via `_pick`/`orDefault`, never truthiness, so `false` and `''` survive; bounds are a 4-array or a left/top/right/bottom object; reads are unvalidated casts."
---
# UI Hierarchy Parsing (common)

**Domain**: common

## Overview

`packages/common/src/models/Hierarchy.ts` turns the driver's UI-hierarchy JSON into `HierarchyNode`s
and the flattened list that `toPromptElementsForPlanner` / `toPromptElementsForGrounder` build
planner and grounder prompts from. Every consumer of `Hierarchy`/`HierarchyNode` lives in
`goal-executor` — `ai/AIAgent.ts`, `ActionExecutor.ts`, `TestExecutor.ts` and
`GrounderResponseConverter.ts`, each importing through the `@finalrun/common` barrel.
**`device-node` consumes neither type**, even though it is the client that fetches every payload
(`GrpcDriverClient.getHierarchy` / `getScreenshotAndHierarchy`) and owns a
`DeviceScreenshotAndHierarchy` interface of its own: the hierarchy crosses that package as an opaque
JSON `string` — the declared field type in both `GrpcDriverClient`'s response and
`DeviceRuntime.DeviceScreenshotAndHierarchy` — and only `goal-executor` parses it. So a grep for
`Hierarchy` under `device-node` hits RPC names and that local interface, never this type.
The one production entry point is `Hierarchy.fromJsonString`, called on the device-capture path in
`packages/goal-executor/src/TestExecutor.ts`. A behaviour change here surfaces as a grounding
failure at runtime rather than as a test failure, so the parse contract is pinned by
mutation-verified characterization tests in `packages/common/src/models/test/Hierarchy.test.ts`
(44 tests, green against the pre-refactor source — see [/ci/pr-quality-gate.md](/ci/pr-quality-gate.md)).

Node text reaches the model provider verbatim from here — a field holding a typed secret included.
Redaction for that is downstream and generic over string fields: `AIAgent` rewrites exact resolved
secret values in the records these two builders return, before serializing them, whenever runtime
bindings are wired ([/cli/test-compiler.md](/cli/test-compiler.md)). It never mutates the
`Hierarchy`, which keeps holding the real on-screen values — so this file has no bindings access and
needs none.

## Requirements

### Requirement: Two parse paths, deliberately not equivalent
`fromJsonString` MUST dispatch on payload shape — a JSON array to `fromFlatJson` (→ `_parseFlatNode`),
a JSON object to `fromJson` (→ `_parseNode`) — and MUST return `new Hierarchy(null)` on a
`JSON.parse` failure rather than throwing. The two node parsers carry different contracts, and each
difference MUST be preserved:

| | flat path (`_parseFlatNode`) | tree path (`_parseNode`) |
|---|---|---|
| `id` source | `id` ?? `identifier` | `id` only |
| `:id/` resource ids | shortened to the last segment | left intact |
| `isImage` | explicit flag OR `clazz` containing `ImageView` / `ImageButton` / `SvgView` | explicit flag only |
| `text` | `text` ?? `title` ?? `value` | `text` only |
| `accessibilityText` | `content_desc` ?? `contentDesc` ?? `accessibilityText` ?? `label` | `contentDesc` ?? `accessibilityText` |
| booleans | camelCase ?? snake_case (`isSelected` ?? `is_selected` ?? `is_checked`) | camelCase only |
| result shape | index = array position, `root` is `null`, every node childless | DFS pre-order index, nested children |

Both paths share `clazz` ← `class` ?? `clazz`, `hintText`, `error`, and `_parseBounds`. Aligning the
two is a behaviour change, not a cleanup: the flat path serves the native driver's flattened
payload, where Android resource ids arrive fully qualified and image widgets are identifiable only
by class name.

#### Scenario: the tree path leaves a resource id alone
- **GIVEN** an object payload whose node carries `id: 'com.app:id/login_button'`
- **WHEN** `Hierarchy.fromJson` parses it
- **THEN** the node's `id` is the full `com.app:id/login_button` — the same value on the flat path yields `login_button`

#### Scenario: malformed JSON yields an empty hierarchy
- **GIVEN** a hierarchy string that is not valid JSON
- **WHEN** `fromJsonString` parses it
- **THEN** it returns a `Hierarchy` with `root === null` and an empty `flattenedHierarchy`, and does not throw

### Requirement: Alias resolution is presence-based, never truthiness
`Hierarchy._pick(json, keys, fallback)` MUST return the value of the first key that is neither
`null` nor `undefined`, and MUST fall back only when every key is absent; `orDefault(value, fallback)`
applies the same rule to `HierarchyNode`'s constructor params. Falsy-but-present payload values
therefore survive: `text: ''` stays `''`, `isScrollable: false` stays `false` even when
`is_scrollable: true` follows it in the chain, and `isSelected: false` is not replaced by
`is_checked: true`. Roughly ten alias chains resolve through this one helper, so it MUST NOT become
`||` or any other truthiness test.

#### Scenario: an explicit false outranks a later true alias
- **GIVEN** a flat node `{ isScrollable: false, is_scrollable: true }`
- **WHEN** `fromFlatJson` parses it
- **THEN** `isScrollable` is `false`

#### Scenario: the presence rule is load-bearing
- **GIVEN** `_pick`'s presence test rewritten as a truthiness check
- **WHEN** the characterization suite runs
- **THEN** exactly nine tests fail — one falsy-but-present case per chain

### Requirement: Bounds accept two forms and nothing else
`_parseBounds` MUST produce `[left, top, right, bottom]` from a 4-element array (each element through
`Number`, so string digits coerce) or from an object carrying all four of `left`/`top`/`right`/`bottom`,
and MUST produce `null` for anything else — a wrong-length array, a non-object, or an absent
`bounds`. Both parse paths use it, so `HierarchyNode.getCenterPoint()` returns `null` exactly when
bounds did not parse.

### Requirement: Field reads are unvalidated casts
Every aliased field read returns through `_pick`'s single `value as T` with no runtime type check, so
a payload whose `text` is a number yields a `HierarchyNode.text` declared `string` and holding a
number — the same defect class as `SimctlClient._trimmed`. Consumers MUST NOT treat the declared
node types as guarantees about arbitrary driver payloads.

## Design Decisions

### The two parse paths stay asymmetric, and the asymmetry is pinned negatively
**Decision**: The flat-path-only behaviours — `:id/` shortening, class-derived `isImage`, the
`identifier` alias, the wider text and boolean alias sets — stay flat-path-only, and the tree path
carries characterization tests asserting that it does **not** do them.
**Why**: The asymmetry reads as an oversight, so the plausible next edit is to "make the two
consistent" — and nothing else in the repo would catch that edit. Both paths feed prompt builders,
so a wrongly-shortened id or a wrongly-inferred `isImage` changes what the grounder is *told* rather
than failing an assertion, and lands as a grounding failure at runtime. A positive test on the flat
path stays green through such an edit; only an explicit negative test on the tree path fails.
**Rejected**: unifying the two parsers behind one node builder — a behaviour change to whichever
path loses features, dressed as deduplication, and it would need its own argument about what the
driver actually sends for each payload shape.
*Introduced by*: 260729-24wz-exempt-test-lengths-refactor-common

### One presence-based helper carries every alias chain
**Decision**: All alias chains resolve through the single `_pick` helper, and typed-param defaulting
through `orDefault`, each testing `!== null && !== undefined`. `id` and `isImage` keep their own
logic on top of it: `_pick` supplies only the alias lookup, while the `:id/` shortening and the
class-marker disjunction (`_isImageNode`) stay separate.
**Why**: The helper is the highest-risk line in the file — around ten chains route through it, so a
version written with `||` changes all of them at once, and in the direction a reader is least likely
to suspect: `false` and `''` are meaningful payload values here, and the prompt builders omit falsy
fields, so a flipped rule silently changes prompt content instead of raising anything. Concentrating
the rule in one function makes it one reviewable line and one mutation to verify, which is why the
suite pins it nine times over. `id` and `isImage` stay out because they are not alias chains —
folding them in would hide post-processing and a disjunction behind a name that promises
first-present-wins.
**Rejected**: (a) `value || fallback`, or any truthiness test — drops every falsy-but-present value
across every chain simultaneously; (b) a helper per field — ten places for the presence rule to
drift apart; (c) routing `id` and `isImage` through `_pick` for uniformity — DRY at the cost of
hiding the two behaviours that make those fields different.
*Introduced by*: 260729-24wz-exempt-test-lengths-refactor-common

### `complexity` counts every `??`, so a data mapper trips it without being complex
**Decision**: ESLint's `complexity` counts each `??` (as it does `||` and `&&`) as a branch, so a
function whose only logic is defaulting a list of optional fields scores high with no control flow at
all: `HierarchyNode`'s 13-field constructor scores **14** with zero branching statements, and
`_parseFlatNode`'s repeated alias chains reached **36** with a single `if` in the whole function.
Such a warning is cleared by moving the defaulting behind one helper — `orDefault`, `_pick` — which
fixes the metric and leaves readability where it already was.
**Why**: The gap between this rule and its intent belongs to the tooling rather than to any one
function, and it recurs on every data-shaped mapper with many optional fields — so a reader who
meets a `complexity` warning there needs to recognise the artifact instead of inventing a
decomposition to satisfy it. It also bounds what promoting the code-quality rules from `warn` to
`error` buys ([/ci/pr-quality-gate.md](/ci/pr-quality-gate.md)): part of the count is branch-free
defaulting, where the promotion forces a wrapper per site rather than surfacing a readability
problem. Naming the property keeps the honest responses available — collapse the chains through one
helper, or leave the warning standing — instead of a split that damages the code to move a number.
**Rejected**: tuning the rule for these functions (raising the ceiling, or disabling `complexity` on
mapper-shaped files) — the same threshold is what catches genuinely branchy code, and a shape-based
exemption has no boundary a reader can check.
*Introduced by*: 260729-24wz-exempt-test-lengths-refactor-common

### The unvalidated cast is consolidated, not validated
**Decision**: The per-field `as string` / `as boolean` reads live as `_pick`'s single `value as T`,
still without runtime validation; validation is not added by the change that restructures the
parser.
**Why**: Validating changes behaviour on malformed payloads — a number-valued `text` currently
reaches the prompt as a number — which is precisely what the characterization suite's equivalence
proof rules out, so adding it would void the proof that makes the restructuring safe. What the
restructuring does buy is a single site: the lying read is one line rather than twenty, and the
suite that proved the restructuring equivalent is the safety net a later fix needs.
**Rejected**: validating inside `_pick` while restructuring — couples a behaviour change to a change
whose whole claim is that nothing changed, leaving a reviewer nothing to check the equivalence
against.
*Introduced by*: 260729-24wz-exempt-test-lengths-refactor-common
