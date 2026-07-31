import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_FEATURES,
  PLATFORM_ANDROID,
  PLATFORM_IOS,
  type FeatureName,
  type FeatureOverride,
  type FeatureOverrides,
  type ReasoningLevel,
} from './constants.js';
import type { AppConfig } from './models/Environment.js';
import YAML from 'yaml';
import { readAppConfig } from './appConfig.js';
import { parseReasoningLevel } from './constants.js';
import { promptForWorkspaceSelection, type WorkspaceSelectionIO } from './workspacePicker.js';

function resolveFinalRunRootDir(): string {
  return path.join(os.homedir(), '.finalrun');
}

export interface FinalRunWorkspace {
  rootDir: string;
  finalrunDir: string;
  testsDir: string;
  suitesDir: string;
  envDir: string;
  artifactsDir: string;
}

export interface AppOverrideValidationResult {
  appPath: string;
  inferredPlatform: string;
  resolvedIdentifier?: string;
}

export interface WorkspaceConfig {
  env?: string;
  model?: string;
  reasoning?: ReasoningLevel;
  features?: FeatureOverrides;
  app?: AppConfig;
}

export interface ResolvedEnvironmentFile {
  envName: string;
  envPath?: string;
  availableEnvNames: string[];
  usesEmptyBindings: boolean;
}

export interface WorkspaceMetadataRecord {
  schemaVersion: number;
  workspaceRoot: string;
  canonicalWorkspaceRoot: string;
  workspaceHash: string;
  artifactsDir: string;
  displayName?: string;
  lastUsedAt?: string;
}

export interface RegisteredWorkspaceEntry {
  workspace: FinalRunWorkspace;
  displayName: string;
  lastUsedAt?: string;
  metadataPath: string;
}

const WORKSPACE_CONFIG_TOP_LEVEL_KEYS = new Set([
  'env',
  'model',
  'reasoning',
  'features',
  'app',
]);
const FEATURE_OVERRIDE_KEYS = new Set(['model', 'reasoning']);
const ALL_FEATURES_SET = new Set<string>(ALL_FEATURES);
const WORKSPACE_HASH_LENGTH = 16;

export async function resolveWorkspace(
  cwd: string = process.cwd(),
): Promise<FinalRunWorkspace> {
  const workspaceRoot = await findWorkspaceRoot(cwd);
  if (workspaceRoot) {
    return finalizeResolvedWorkspace(await buildWorkspace(workspaceRoot));
  }
  throw new Error(
    'Could not find a .finalrun workspace. Run the CLI from a repository containing .finalrun/.',
  );
}

export async function resolveWorkspaceFromPath(
  workspacePath: string,
  options?: { requireSelectableWorkspace?: boolean },
): Promise<FinalRunWorkspace> {
  const normalizedPath = workspacePath.trim();
  if (normalizedPath.length === 0) {
    throw new Error('Missing workspace path. Pass --workspace <path>.');
  }

  const resolvedPath = path.resolve(normalizedPath);
  const workspaceRoot = await findWorkspaceRoot(
    resolvedPath,
    options?.requireSelectableWorkspace ? isSelectableWorkspaceRoot : isWorkspaceRootCandidate,
  );
  if (workspaceRoot) {
    return buildWorkspace(workspaceRoot);
  }

  throw new Error(
    `Path is not inside a FinalRun workspace: ${resolvedPath}. Pass --workspace <path> that points to a repository containing .finalrun/.`,
  );
}

export async function resolveWorkspaceForCommand(params?: {
  cwd?: string;
  workspacePath?: string;
  io?: WorkspaceSelectionIO;
}): Promise<FinalRunWorkspace> {
  const cwd = params?.cwd ?? process.cwd();
  const explicitWorkspacePath = params?.workspacePath?.trim();
  let workspace: FinalRunWorkspace | undefined;

  if (explicitWorkspacePath) {
    workspace = await resolveWorkspaceFromPath(explicitWorkspacePath, {
      requireSelectableWorkspace: true,
    });
  } else {
    workspace = await tryResolveWorkspace(cwd, {
      requireSelectableWorkspace: true,
    });
    if (!workspace && params?.io?.isTTY) {
      const registeredWorkspaces = await listRegisteredWorkspaces();
      if (registeredWorkspaces.length > 0) {
        const selection = await promptForWorkspaceSelection({
          heading: 'Select a FinalRun workspace',
          entries: registeredWorkspaces.map((entry) => ({
            label: entry.displayName,
            workspaceRoot: entry.workspace.rootDir,
          })),
          io: params.io,
        });
        workspace = await resolveWorkspaceFromPath(selection.workspaceRoot);
      }
    }
  }

  if (!workspace) {
    throw new Error(
      `Could not find a .finalrun workspace from ${path.resolve(cwd)}. Pass --workspace <path> to target a FinalRun workspace explicitly.`,
    );
  }

  return finalizeResolvedWorkspace(workspace);
}

async function finalizeResolvedWorkspace(
  workspace: FinalRunWorkspace,
): Promise<FinalRunWorkspace> {
  await ensureWorkspaceDirectories(workspace);
  await refreshWorkspaceUsageMetadata(workspace);
  return workspace;
}

export async function ensureWorkspaceDirectories(
  workspace: FinalRunWorkspace,
): Promise<void> {
  if (!(await pathExists(workspace.testsDir))) {
    throw new Error(`Missing .finalrun/tests directory: ${workspace.testsDir}`);
  }

  await fs.mkdir(workspace.artifactsDir, { recursive: true });
  await writeWorkspaceArtifactMetadata(workspace);
}

export async function listRegisteredWorkspaces(): Promise<RegisteredWorkspaceEntry[]> {
  const workspaceRegistryRoot = resolveWorkspaceArtifactsRootDir();
  const entries = await fs.readdir(workspaceRegistryRoot, { withFileTypes: true }).catch(() => []);
  const registeredWorkspaces: RegisteredWorkspaceEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const metadataPath = path.join(workspaceRegistryRoot, entry.name, 'workspace.json');
    const metadata = await readWorkspaceMetadataFromPath(metadataPath);
    if (!metadata?.workspaceRoot) {
      continue;
    }

    const workspace = await buildWorkspace(metadata.workspaceRoot);
    if (!(await isSelectableRegisteredWorkspace(workspace))) {
      continue;
    }

    let displayName = normalizeMetadataString(metadata.displayName);
    if (!displayName) {
      displayName = await deriveWorkspaceDisplayName(workspace.rootDir);
      await writeWorkspaceArtifactMetadata(workspace, {
        displayName,
        lastUsedAt: metadata.lastUsedAt,
      });
    }

    registeredWorkspaces.push({
      workspace,
      displayName,
      lastUsedAt: normalizeMetadataString(metadata.lastUsedAt),
      metadataPath,
    });
  }

  registeredWorkspaces.sort(compareRegisteredWorkspaces);
  return registeredWorkspaces;
}

export async function refreshWorkspaceUsageMetadata(
  workspace: FinalRunWorkspace,
): Promise<WorkspaceMetadataRecord> {
  const existingMetadata = await readWorkspaceArtifactMetadata(workspace);
  const displayName =
    normalizeMetadataString(existingMetadata?.displayName) ??
    (await deriveWorkspaceDisplayName(workspace.rootDir));
  return writeWorkspaceArtifactMetadata(workspace, {
    displayName,
    lastUsedAt: new Date().toISOString(),
  });
}

export async function createWorkspaceHash(workspaceRoot: string): Promise<string> {
  const canonicalRoot = await resolveCanonicalWorkspaceRoot(workspaceRoot);
  return crypto
    .createHash('sha256')
    .update(normalizeWorkspaceRootForHash(canonicalRoot))
    .digest('hex')
    .slice(0, WORKSPACE_HASH_LENGTH);
}

export function resolveWorkspaceArtifactsRootDir(): string {
  return path.join(resolveFinalRunRootDir(), 'workspaces');
}

export async function resolveWorkspaceArtifactsDir(workspaceRoot: string): Promise<string> {
  return path.join(
    resolveWorkspaceArtifactsRootDir(),
    await createWorkspaceHash(workspaceRoot),
    'artifacts',
  );
}

export function assertPathWithinRoot(
  rootDir: string,
  candidatePath: string,
  description: string,
): void {
  const relative = path.relative(rootDir, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${description} must stay inside ${rootDir}`);
  }
}

export function sanitizeId(relativePath: string): string {
  return relativePath
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/]+/g, '__')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-');
}

export function createRunId(params: {
  envName: string;
  platform: string;
  startedAt: Date;
}): string {
  const timestamp = params.startedAt.toISOString().replace(/[:]/g, '-');
  return `${timestamp}-${params.envName}-${params.platform}`;
}

export async function validateAppOverride(
  appPath: string,
  platform?: string,
): Promise<AppOverrideValidationResult> {
  const resolvedPath = path.resolve(appPath);
  const stats = await fs.stat(resolvedPath).catch(() => null);
  if (!stats) {
    throw new Error(`App override not found: ${resolvedPath}`);
  }

  const lowerPath = resolvedPath.toLowerCase();
  if (lowerPath.endsWith('.apk')) {
    if (!stats.isFile()) {
      throw new Error('Android .apk overrides must point to an APK file.');
    }
    if (platform && platform !== PLATFORM_ANDROID) {
      throw new Error('Android .apk overrides require --platform android.');
    }
    return {
      appPath: resolvedPath,
      inferredPlatform: PLATFORM_ANDROID,
    };
  }

  if (lowerPath.endsWith('.app')) {
    if (!stats.isDirectory()) {
      throw new Error('iOS .app overrides must point to an extracted .app bundle directory.');
    }
    if (platform && platform !== PLATFORM_IOS) {
      throw new Error('iOS .app overrides require --platform ios.');
    }
    return {
      appPath: resolvedPath,
      inferredPlatform: PLATFORM_IOS,
    };
  }

  throw new Error('Unsupported --app override. Expected an Android .apk or iOS simulator .app.');
}

export function isYamlFile(filePath: string): boolean {
  return /\.ya?ml$/i.test(filePath);
}

export async function resolveSuiteManifestPath(
  suitesDir: string,
  suitePath: string,
): Promise<string> {
  if (!(await pathExists(suitesDir))) {
    throw new Error(`Missing .finalrun/suites directory: ${suitesDir}`);
  }

  const resolvedPath = resolveWorkspaceScopedPath(suitePath, suitesDir, '.finalrun/suites/');
  assertPathWithinRoot(suitesDir, resolvedPath, 'Suite manifest');

  if (!isYamlFile(resolvedPath)) {
    throw new Error(`Suite manifest must point to a .yaml or .yml file: ${suitePath}`);
  }

  const stats = await fs.stat(resolvedPath).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`Suite manifest not found: ${resolvedPath}`);
  }

  return resolvedPath;
}

export async function resolveEnvironmentFile(
  envDir: string,
  requestedEnvName?: string,
): Promise<ResolvedEnvironmentFile> {
  const envDirExists = await pathExists(envDir);
  const environmentFiles = await listEnvironmentFiles(envDir);
  const availableEnvNames = environmentFiles.map((entry) => entry.envName);
  const duplicateNames = findDuplicateEnvironmentNames(availableEnvNames);
  if (duplicateNames.length > 0) {
    throw new Error(
      `Environment files in ${envDir} contain duplicate names: ${duplicateNames.join(', ')}.`,
    );
  }

  if (requestedEnvName) {
    const explicitMatch = environmentFiles.find(
      (entry) => entry.envName === requestedEnvName,
    );
    if (!explicitMatch) {
      throw new Error(
        formatMissingEnvironmentError(
          envDir,
          requestedEnvName,
          availableEnvNames,
          envDirExists,
        ),
      );
    }
    return {
      envName: explicitMatch.envName,
      envPath: explicitMatch.envPath,
      availableEnvNames,
      usesEmptyBindings: false,
    };
  }

  return selectDefaultEnvironmentFile(envDir, environmentFiles, availableEnvNames);
}

/**
 * Pick the environment when no name was requested: empty bindings when no env
 * files exist, `dev` when present, the sole file when there is exactly one,
 * and an actionable error when the choice is ambiguous.
 */
function selectDefaultEnvironmentFile(
  envDir: string,
  environmentFiles: Array<{ envName: string; envPath: string }>,
  availableEnvNames: string[],
): ResolvedEnvironmentFile {
  if (environmentFiles.length === 0) {
    return {
      envName: 'none',
      availableEnvNames,
      usesEmptyBindings: true,
    };
  }

  const devMatch = environmentFiles.find((entry) => entry.envName === 'dev');
  if (devMatch) {
    return {
      envName: devMatch.envName,
      envPath: devMatch.envPath,
      availableEnvNames,
      usesEmptyBindings: false,
    };
  }

  if (environmentFiles.length === 1) {
    return {
      envName: environmentFiles[0]!.envName,
      envPath: environmentFiles[0]!.envPath,
      availableEnvNames,
      usesEmptyBindings: false,
    };
  }

  throw new Error(
    `Multiple environments are available in ${envDir}. Pass --env <name>. Available environments: ${availableEnvNames.join(', ')}`,
  );
}

export async function loadWorkspaceConfig(finalrunDir: string): Promise<WorkspaceConfig> {
  const configPath = path.join(finalrunDir, 'config.yaml');
  if (!(await pathExists(configPath))) {
    return {};
  }

  const raw = await fs.readFile(configPath, 'utf-8').catch(() => {
    throw new Error(`Workspace config file not found: ${configPath}`);
  });

  const parsed = parseYamlDocument(raw, configPath);
  if (parsed === undefined || parsed === null) {
    return {};
  }

  assertPlainObject(parsed, `Workspace config ${configPath}`);
  assertAllowedKeys(parsed, WORKSPACE_CONFIG_TOP_LEVEL_KEYS, `Workspace config ${configPath}`);

  return {
    env: readOptionalTrimmedString(parsed['env'], `${configPath} env`, {
      allowEmpty: false,
    }),
    model: readOptionalTrimmedString(parsed['model'], `${configPath} model`, {
      allowEmpty: true,
    }),
    reasoning: parseReasoningLevel(parsed['reasoning'], `${configPath} reasoning`),
    features: readFeaturesConfig(parsed['features'], `${configPath} features`),
    app: readAppConfig(parsed['app'], `${configPath} app`),
  };
}

function readFeaturesConfig(value: unknown, label: string): FeatureOverrides | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  assertPlainObject(value, label);
  assertAllowedKeys(value, ALL_FEATURES_SET, label);

  const overrides: FeatureOverrides = {};
  for (const [featureKey, rawOverride] of Object.entries(value)) {
    if (rawOverride === undefined || rawOverride === null) {
      continue;
    }
    const featureLabel = `${label}.${featureKey}`;
    assertPlainObject(rawOverride, featureLabel);
    assertAllowedKeys(rawOverride, FEATURE_OVERRIDE_KEYS, featureLabel);

    const override: FeatureOverride = {};
    const model = readOptionalTrimmedString(rawOverride['model'], `${featureLabel}.model`, {
      allowEmpty: false,
    });
    if (model !== undefined) {
      override.model = model;
    }
    const reasoning = parseReasoningLevel(rawOverride['reasoning'], `${featureLabel}.reasoning`);
    if (reasoning !== undefined) {
      override.reasoning = reasoning;
    }
    if (override.model !== undefined || override.reasoning !== undefined) {
      overrides[featureKey as FeatureName] = override;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export async function resolveConfiguredEnvironmentFile(
  workspace: FinalRunWorkspace,
  requestedEnvName?: string,
): Promise<ResolvedEnvironmentFile> {
  const workspaceConfig = await loadWorkspaceConfig(workspace.finalrunDir);
  return resolveEnvironmentFile(
    workspace.envDir,
    requestedEnvName ?? workspaceConfig.env,
  );
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function writeWorkspaceArtifactMetadata(
  workspace: FinalRunWorkspace,
  updates: Partial<Pick<WorkspaceMetadataRecord, 'displayName' | 'lastUsedAt'>> = {},
): Promise<WorkspaceMetadataRecord> {
  const canonicalWorkspaceRoot = await resolveCanonicalWorkspaceRoot(workspace.rootDir);
  const workspaceHash = await createWorkspaceHash(workspace.rootDir);
  const metadataPath = getWorkspaceMetadataPath(workspace);
  const existingMetadata = await readWorkspaceMetadataFromPath(metadataPath);
  const metadata: WorkspaceMetadataRecord = {
    schemaVersion: 1,
    workspaceRoot: workspace.rootDir,
    canonicalWorkspaceRoot,
    workspaceHash,
    artifactsDir: workspace.artifactsDir,
  };
  const displayName = normalizeMetadataString(updates.displayName ?? existingMetadata?.displayName);
  const lastUsedAt = normalizeMetadataString(updates.lastUsedAt ?? existingMetadata?.lastUsedAt);

  if (displayName) {
    metadata.displayName = displayName;
  }
  if (lastUsedAt) {
    metadata.lastUsedAt = lastUsedAt;
  }

  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
  return metadata;
}

async function resolveCanonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(workspaceRoot);
  try {
    return await fs.realpath(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

function normalizeWorkspaceRootForHash(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
}

async function tryResolveWorkspace(
  cwd: string,
  options?: { requireSelectableWorkspace?: boolean },
): Promise<FinalRunWorkspace | undefined> {
  const workspaceRoot = await findWorkspaceRoot(
    cwd,
    options?.requireSelectableWorkspace ? isSelectableWorkspaceRoot : isWorkspaceRootCandidate,
  );
  return workspaceRoot ? buildWorkspace(workspaceRoot) : undefined;
}

async function buildWorkspace(workspaceRoot: string): Promise<FinalRunWorkspace> {
  const rootDir = path.resolve(workspaceRoot);
  const finalrunDir = path.join(rootDir, '.finalrun');
  return {
    rootDir,
    finalrunDir,
    testsDir: path.join(finalrunDir, 'tests'),
    suitesDir: path.join(finalrunDir, 'suites'),
    envDir: path.join(finalrunDir, 'env'),
    artifactsDir: await resolveWorkspaceArtifactsDir(rootDir),
  };
}

async function findWorkspaceRoot(
  startPath: string,
  isWorkspaceRoot: (candidateRoot: string) => Promise<boolean> = isWorkspaceRootCandidate,
): Promise<string | undefined> {
  const resolvedStartPath = path.resolve(startPath);
  const stats = await fs.stat(resolvedStartPath).catch(() => null);
  let currentDir = stats?.isFile() ? path.dirname(resolvedStartPath) : resolvedStartPath;

  while (true) {
    if (await isWorkspaceRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

async function readWorkspaceArtifactMetadata(
  workspace: FinalRunWorkspace,
): Promise<WorkspaceMetadataRecord | undefined> {
  return readWorkspaceMetadataFromPath(getWorkspaceMetadataPath(workspace));
}

async function readWorkspaceMetadataFromPath(
  metadataPath: string,
): Promise<WorkspaceMetadataRecord | undefined> {
  try {
    const raw = await fs.readFile(metadataPath, 'utf-8');
    return parseWorkspaceMetadataRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function getWorkspaceMetadataPath(workspace: FinalRunWorkspace): string {
  return path.join(workspace.artifactsDir, '..', 'workspace.json');
}

async function isSelectableRegisteredWorkspace(
  workspace: FinalRunWorkspace,
): Promise<boolean> {
  return isSelectableWorkspaceRoot(workspace.rootDir);
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await fs.stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isWorkspaceRootCandidate(candidateRoot: string): Promise<boolean> {
  return isDirectory(path.join(candidateRoot, '.finalrun'));
}

async function isSelectableWorkspaceRoot(candidateRoot: string): Promise<boolean> {
  return (await isWorkspaceRootCandidate(candidateRoot)) &&
    (await isDirectory(path.join(candidateRoot, '.finalrun', 'tests')));
}

function compareRegisteredWorkspaces(
  left: RegisteredWorkspaceEntry,
  right: RegisteredWorkspaceEntry,
): number {
  const leftTimestamp = Date.parse(left.lastUsedAt ?? '');
  const rightTimestamp = Date.parse(right.lastUsedAt ?? '');
  const normalizedLeftTimestamp = Number.isNaN(leftTimestamp) ? 0 : leftTimestamp;
  const normalizedRightTimestamp = Number.isNaN(rightTimestamp) ? 0 : rightTimestamp;

  if (normalizedRightTimestamp !== normalizedLeftTimestamp) {
    return normalizedRightTimestamp - normalizedLeftTimestamp;
  }

  const labelOrder = left.displayName.localeCompare(right.displayName);
  if (labelOrder !== 0) {
    return labelOrder;
  }

  return left.workspace.rootDir.localeCompare(right.workspace.rootDir);
}

async function deriveWorkspaceDisplayName(workspaceRoot: string): Promise<string> {
  const packageName = await readWorkspacePackageName(workspaceRoot);
  if (packageName) {
    return packageName;
  }

  const originSlug = readWorkspaceOriginRepoSlug(workspaceRoot);
  if (originSlug) {
    return originSlug;
  }

  return path.basename(workspaceRoot);
}

async function readWorkspacePackageName(workspaceRoot: string): Promise<string | undefined> {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function readWorkspaceOriginRepoSlug(workspaceRoot: string): string | undefined {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: workspaceRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return undefined;
  }
  return parseGitOriginRepoSlug(result.stdout);
}

function parseGitOriginRepoSlug(remoteUrl: string): string | undefined {
  const normalizedRemoteUrl = remoteUrl.trim();
  if (normalizedRemoteUrl.length === 0) {
    return undefined;
  }

  try {
    return normalizeRepoSlugPath(new URL(normalizedRemoteUrl).pathname);
  } catch {
    const scpStyleMatch = /^(?:.+@)?[^:]+:(.+)$/.exec(normalizedRemoteUrl);
    if (scpStyleMatch) {
      return normalizeRepoSlugPath(scpStyleMatch[1]);
    }
    return undefined;
  }
}

function normalizeRepoSlugPath(value: string): string | undefined {
  const normalizedValue = value.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return normalizedValue.length > 0 ? normalizedValue : undefined;
}

function normalizeMetadataString(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}

function parseWorkspaceMetadataRecord(value: unknown): WorkspaceMetadataRecord | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const workspaceRoot = readMetadataPathString(value.workspaceRoot);
  const canonicalWorkspaceRoot = readMetadataPathString(value.canonicalWorkspaceRoot);
  const workspaceHash = readMetadataString(value.workspaceHash);
  const artifactsDir = readMetadataPathString(value.artifactsDir);
  if (!workspaceRoot || !canonicalWorkspaceRoot || !workspaceHash || !artifactsDir) {
    return undefined;
  }

  const schemaVersion = typeof value.schemaVersion === 'number' &&
      Number.isInteger(value.schemaVersion) &&
      value.schemaVersion > 0
    ? value.schemaVersion
    : 1;

  const metadata: WorkspaceMetadataRecord = {
    schemaVersion,
    workspaceRoot,
    canonicalWorkspaceRoot,
    workspaceHash,
    artifactsDir,
  };

  const displayName = readMetadataString(value.displayName);
  const lastUsedAt = readMetadataString(value.lastUsedAt);
  if (displayName) {
    metadata.displayName = displayName;
  }
  if (lastUsedAt) {
    metadata.lastUsedAt = lastUsedAt;
  }

  return metadata;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMetadataString(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeMetadataString(value) : undefined;
}

function readMetadataPathString(value: unknown): string | undefined {
  const normalizedValue = readMetadataString(value);
  return normalizedValue ? path.resolve(normalizedValue) : undefined;
}

async function listEnvironmentFiles(
  envDir: string,
): Promise<Array<{ envName: string; envPath: string }>> {
  if (!(await pathExists(envDir))) {
    return [];
  }
  const entries = await fs.readdir(envDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isYamlFile(entry.name))
    .map((entry) => ({
      envName: path.basename(entry.name, path.extname(entry.name)),
      envPath: path.join(envDir, entry.name),
    }))
    .sort((left, right) => left.envName.localeCompare(right.envName));
}

function findDuplicateEnvironmentNames(envNames: string[]): string[] {
  const counts = new Map<string, number>();
  for (const envName of envNames) {
    counts.set(envName, (counts.get(envName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([envName]) => envName)
    .sort((left, right) => left.localeCompare(right));
}

function formatMissingEnvironmentError(
  envDir: string,
  requestedEnvName: string,
  availableEnvNames: string[],
  envDirExists: boolean,
): string {
  if (!envDirExists) {
    return `Environment "${requestedEnvName}" was requested, but ${envDir} does not exist. Create .finalrun/env/${requestedEnvName}.yaml or omit --env for env-free tests.`;
  }
  if (availableEnvNames.length === 0) {
    return `Environment "${requestedEnvName}" was not found in ${envDir}, and no environment files are available there. Create .finalrun/env/${requestedEnvName}.yaml or omit --env for env-free tests.`;
  }

  return `Environment "${requestedEnvName}" was not found in ${envDir}. Available environments: ${availableEnvNames.join(', ')}`;
}

function resolveWorkspaceScopedPath(
  candidatePath: string,
  scopedRootDir: string,
  workspacePrefix: string,
): string {
  const normalizedCandidatePath = candidatePath.split(path.sep).join('/');
  const workspaceRoot = path.resolve(scopedRootDir, '..', '..');
  if (path.isAbsolute(candidatePath)) {
    return path.resolve(candidatePath);
  }

  if (normalizedCandidatePath.startsWith(workspacePrefix)) {
    return path.resolve(workspaceRoot, candidatePath);
  }

  return path.resolve(scopedRootDir, candidatePath);
}

function parseYamlDocument(raw: string, filePath: string): unknown {
  const document = YAML.parseDocument(raw);
  if (document.errors.length > 0) {
    const firstError = document.errors[0];
    throw new Error(`Invalid YAML in ${filePath}: ${firstError.message}`);
  }
  return document.toJS();
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a YAML mapping at the top level.`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `${label} contains unsupported key "${key}". Supported keys: ${Array.from(allowedKeys).join(', ')}.`,
      );
    }
  }
}

function readOptionalTrimmedString(
  value: unknown,
  label: string,
  options?: { allowEmpty?: boolean },
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }

  const normalizedValue = value.trim();
  if (!options?.allowEmpty && normalizedValue.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return normalizedValue;
}
