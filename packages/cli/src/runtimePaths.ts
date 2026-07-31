import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Read the CLI version from the package.json that sits next to this source
// file. Under tsc-Node16 the file compiles to CJS so `require` is the global
// loader; under Bun's compile pipeline the JSON is bundled into the
// executable. Either way the version is available without walking the
// build-machine __dirname at runtime (which doesn't exist on the deploy
// machine for Bun-compiled binaries).
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cliPackageJson: { version?: string } = require('../package.json');
const BUNDLED_CLI_VERSION: string = cliPackageJson.version ?? '0.0.0';

interface FinalRunPackageJson {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
}

function readJsonFile(filePath: string): FinalRunPackageJson | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FinalRunPackageJson;
  } catch {
    return undefined;
  }
}

function isCliPackageJson(packageJson: FinalRunPackageJson | undefined): boolean {
  return packageJson?.name === 'finalrun' ||
    packageJson?.name === '@finalrun/cli' ||
    packageJson?.bin?.['finalrun'] !== undefined;
}

function findCliPackageRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath) && isCliPackageJson(readJsonFile(packageJsonPath))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find the FinalRun CLI package root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

export function resolveCliPackageRoot(startDir: string = __dirname): string {
  return findCliPackageRoot(startDir);
}

export function resolveCliPackageVersion(_startDir: string = __dirname): string {
  // Always return the version inlined at build time. We previously walked up
  // from __dirname looking for a package.json, but in a Bun-compiled binary
  // __dirname is the source path on the build machine and doesn't exist on
  // the deploy machine, causing a fatal startup error.
  return BUNDLED_CLI_VERSION;
}

export function resolveFinalRunRootDir(): string {
  return path.join(os.homedir(), '.finalrun');
}

// Set to "true" by `bun build --define` in scripts/build-binary.sh; undefined
// in dev / tsc / `bun run` paths. Mirrors the declaration in localRuntime.ts.
declare const FINALRUN_IS_STANDALONE_BINARY: string | undefined;

export function resolveCliLaunchArgs(
  args: readonly string[],
  startDir: string = __dirname,
): string[] {
  // Standalone Bun-compiled binary: process.execPath IS the entrypoint, and
  // none of the build-machine __dirname-relative candidates below exist on
  // the user's machine. Bun's compile already shapes the child's argv as
  // ['bun', '/$bunfs/...', ...args], so Commander's default `from='node'`
  // (which slices(2)) lands exactly on the user-supplied args — no need to
  // prepend a script slot ourselves.
  if (
    typeof FINALRUN_IS_STANDALONE_BINARY !== 'undefined' &&
    FINALRUN_IS_STANDALONE_BINARY === 'true'
  ) {
    return [...args];
  }

  const compiledBinPath = path.resolve(startDir, '../bin/finalrun.js');
  if (fs.existsSync(compiledBinPath)) {
    return [compiledBinPath, ...args];
  }

  const sourceBinCandidates = [
    path.resolve(startDir, '../bin/finalrun.ts'),
    path.resolve(startDir, '../../bin/finalrun.ts'),
  ];
  const tsxCliCandidates = [
    path.resolve(startDir, '../../../node_modules/tsx/dist/cli.mjs'),
    path.resolve(startDir, '../../../../node_modules/tsx/dist/cli.mjs'),
  ];
  const tsconfigCandidates = [
    path.resolve(startDir, '../../../tsconfig.dev.json'),
    path.resolve(startDir, '../../../../tsconfig.dev.json'),
  ];

  const sourceBinPath = sourceBinCandidates.find((candidate) => fs.existsSync(candidate));
  const tsxCliPath = tsxCliCandidates.find((candidate) => fs.existsSync(candidate));
  const tsconfigPath = tsconfigCandidates.find((candidate) => fs.existsSync(candidate));
  if (sourceBinPath && tsxCliPath) {
    return tsconfigPath
      ? [tsxCliPath, '--tsconfig', tsconfigPath, sourceBinPath, ...args]
      : [tsxCliPath, sourceBinPath, ...args];
  }

  throw new Error('Could not resolve a FinalRun CLI entrypoint for background report server startup.');
}

export function initializeCliRuntimeEnvironment(startDir: string = __dirname): void {
  // Look for the local-runtime tarball install location first. When the CLI
  // is running as a Bun-compiled binary, all on-disk assets (driver APKs,
  // gRPC proto, Vite SPA dist) live there rather than next to the binary.
  const runtimeRoot = resolveLocalRuntimeRoot();

  if (!process.env['FINALRUN_DRIVER_PROTO_PATH']) {
    const candidates: string[] = [];
    if (runtimeRoot) {
      candidates.push(path.join(runtimeRoot, 'proto', 'finalrun', 'driver.proto'));
    }
    try {
      const packageRoot = resolveCliPackageRoot(startDir);
      candidates.push(
        path.join(packageRoot, 'proto', 'finalrun', 'driver.proto'),
        path.resolve(packageRoot, '../../proto/finalrun/driver.proto'),
        path.resolve(packageRoot, '../proto/finalrun/driver.proto'),
      );
    } catch {
      // No CLI package root resolvable — happens inside Bun-compiled binaries.
      // Fall back to runtime-tarball location only.
    }

    const resolvedProtoPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (resolvedProtoPath) {
      process.env['FINALRUN_DRIVER_PROTO_PATH'] = resolvedProtoPath;
    }
  }

  if (!process.env['FINALRUN_ASSET_DIR'] && runtimeRoot) {
    const installResources = path.join(runtimeRoot, 'install-resources');
    if (fs.existsSync(installResources)) {
      process.env['FINALRUN_ASSET_DIR'] = installResources;
    }
  }

  if (!process.env['FINALRUN_REPORT_APP_DIR'] && runtimeRoot) {
    const reportApp = path.join(runtimeRoot, 'report-app');
    if (fs.existsSync(reportApp)) {
      process.env['FINALRUN_REPORT_APP_DIR'] = reportApp;
    }
  }

  if (!process.env['FINALRUN_PROMPTS_DIR'] && runtimeRoot) {
    const promptsDir = path.join(runtimeRoot, 'prompts');
    if (fs.existsSync(promptsDir)) {
      process.env['FINALRUN_PROMPTS_DIR'] = promptsDir;
    }
  }
}

function resolveLocalRuntimeRoot(): string | undefined {
  const override = process.env['FINALRUN_RUNTIME_ROOT'];
  if (override && override.trim()) {
    const candidate = path.resolve(override.trim());
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }
  // Honor FINALRUN_DIR so the binary finds the runtime when the user
  // installed via `FINALRUN_DIR=... bash install.sh` to a custom location.
  const finalrunDir =
    process.env['FINALRUN_DIR']?.trim() || path.join(os.homedir(), '.finalrun');
  const versioned = path.join(finalrunDir, 'runtime', resolveCliPackageVersion());
  if (fs.existsSync(path.join(versioned, 'manifest.json'))) {
    return versioned;
  }
  return undefined;
}
