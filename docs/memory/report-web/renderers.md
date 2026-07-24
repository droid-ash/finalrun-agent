---
type: memory
description: "HTML rendering including inline device log viewer"
---
# Renderers (report-web)

`renderers.ts` (`packages/report-web/src/renderers.ts`) generates HTML for the test report viewer. `artifacts.ts` handles manifest loading and artifact resolution.

## Device Log Viewer

### View Model Transformation

`toTestViewModel()` transforms `deviceLogFile` using `buildRunScopedArtifactPath(runId, test.deviceLogFile)` to produce the full artifact route for the download link.

### Inline Collapsible Section

When `deviceLogFile` is present on a test, the renderer outputs:

```html
<details class="device-log">
  <summary>Device log (tail)</summary>
  <pre>{last ~200 lines, HTML-escaped}</pre>
  <a href="{deviceLogRoute}" download>Download full log</a>
</details>
```

This block is positioned after the recording video section. When `deviceLogFile` is undefined, nothing is rendered.

### Server-Side Tail Read

The tail read happens in `artifacts.ts` during manifest loading via `readDeviceLogTail()`:
- Reads the full device log file via `readRunArtifactText()`
- Splits on `\n` and takes `slice(-200)` (last 200 lines)
- Result stored as `deviceLogTailText` on `ReportManifestTestRecord`
- The `<pre>` content is HTML-escaped via `escapeHtml()` in the renderer

### Schema Version

`loadRunManifestRecord()` in `artifacts.ts` accepts schema versions `2` and `3`. Version 2 manifests load without error; device log fields are simply `undefined`.

### CLI Report Template

`reportTemplate.ts` (`packages/cli/src/reportTemplate.ts`) renders the same `<details class="device-log">` block next to the `<video>` tag, using `escapeHtml` for log content.
