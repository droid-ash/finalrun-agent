# Contributing

Thanks for contributing to `finalrun-agent`.

## Development Setup

```sh
git clone https://github.com/final-run/finalrun-agent.git
cd finalrun-agent
npm ci
```

`package-lock.json` is committed and CI installs with `npm ci`, so any change to dependencies must include the updated lockfile in the same commit.

End-user install (binary, not npm):

```sh
curl -fsSL https://raw.githubusercontent.com/final-run/finalrun-agent/main/scripts/install.sh | bash
```

The CLI is no longer published to npm — it ships as a Bun-compiled binary plus a per-platform runtime tarball uploaded to GitHub Releases. See [RELEASING.md](./RELEASING.md) for how a release is cut.

Build the workspace packages:

```sh
npm run build
```

Run the full test suite:

```sh
npm test
```

Run linting and formatting checks:

```sh
npm run lint
npm run format:check
```

## Monorepo Structure

- `packages/common`: shared models, types, and utilities
- `packages/device-node`: device detection, gRPC communication, and platform-specific device runtime logic
- `packages/goal-executor`: AI planning and action execution
- `packages/cli`: CLI source — Bun-compiled into the distributed binary
- `packages/cloud-core`: pure cloud-submission logic shared by the CLI binary
- `packages/local-runtime`: builder for the per-platform runtime tarball (driver bundles, gRPC proto, Vite SPA dist) that ships alongside the binary on GitHub Releases
- `packages/report-web`: local report UI
- `drivers/android`: Android driver sources
- `drivers/ios`: iOS simulator driver sources
- `resources/`: generated runtime assets used by local runs
- `proto/`: shared protobuf definitions

## Native Driver Builds

Build both native drivers:

```sh
npm run build:drivers
```

Build a single platform:

```sh
npm run build:drivers:android
npm run build:drivers:ios
```

If your change touches driver setup, installation, or host checks, include the relevant native build and local verification steps in your PR notes.

## Agent-Assisted Contributions

Contributions authored with AI coding agents must follow the [Fab Kit](https://github.com/sahil87/fab-kit) workflow (intake → spec → tasks → apply → review → hydrate → ship → review-PR).

Before opening a PR, the change must clear all four SRAD dimensions — Scope, Reversibility, Alternatives, and Disambiguation — and must reach a **Confident** or **Certain** grade with no Unresolved dimension; any remaining Tentative assumptions must be surfaced in the PR description.

## Pull Requests

- Keep PRs focused and scoped to a single change or release task.
- Update tests and docs when behavior or public usage changes.
- Include the commands you ran to validate the change.
- Call out any platform-specific caveats for Android, iOS, or host tooling.
- Avoid bundling unrelated refactors into release or bug-fix PRs.

## Code Style

- TypeScript is the primary implementation language across the repo.
- Use the repo ESLint and Prettier configuration before opening a PR.
- Prefer small, targeted changes over broad style churn.
