import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { ReportServerState } from '@finalrun/common';
import {
  buildRunReportUrl,
  getWorkspaceReportServerStatus,
  openReportUrl,
  readWorkspaceReportServerState,
  reportServerManagerDependencies,
  resolveHealthyWorkspaceReportServer,
  startOrReuseWorkspaceReportServer,
  stopWorkspaceReportServer,
  writeWorkspaceReportServerState,
} from './reportServerManager.js';
import type { FinalRunWorkspace } from '@finalrun/common';

function createWorkspace(): FinalRunWorkspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-report-manager-'));
  const finalrunDir = path.join(rootDir, '.finalrun');
  const testsDir = path.join(finalrunDir, 'tests');
  const suitesDir = path.join(finalrunDir, 'suites');
  const envDir = path.join(finalrunDir, 'env');
  const artifactsDir = path.join(
    rootDir,
    '.artifacts-home',
    '.finalrun',
    'workspaces',
    'workspace-hash',
    'artifacts',
  );
  fs.mkdirSync(testsDir, { recursive: true });
  fs.mkdirSync(suitesDir, { recursive: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  return {
    rootDir,
    finalrunDir,
    testsDir,
    suitesDir,
    envDir,
    artifactsDir,
  };
}

function createServerState(workspace: FinalRunWorkspace): ReportServerState {
  return {
    pid: 4321,
    port: 4173,
    url: 'http://127.0.0.1:4173',
    workspaceRoot: workspace.rootDir,
    artifactsDir: workspace.artifactsDir,
    mode: 'production',
    startedAt: '2026-03-24T18:00:00.000Z',
  };
}

function createSpawnedChild(pid: number): ChildProcess {
  return {
    pid,
    unref() {},
  } as ChildProcess;
}

async function findAvailablePort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No ephemeral port allocated.')));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

test('resolveHealthyWorkspaceReportServer returns the persisted state for a healthy workspace server', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => ({
      status: 200,
      body: {
        status: 'ok',
        workspaceRoot: workspace.rootDir,
        artifactsDir: workspace.artifactsDir,
      },
    });

    const state = await resolveHealthyWorkspaceReportServer(workspace);
    assert.equal(state?.url, 'http://127.0.0.1:4173');
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('resolveHealthyWorkspaceReportServer clears stale state when the health check fails', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => {
      throw new Error('connection refused');
    };

    const state = await resolveHealthyWorkspaceReportServer(workspace);
    assert.equal(state, undefined);
    const persistedState = await readWorkspaceReportServerState(workspace);
    assert.equal(persistedState, undefined);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('startOrReuseWorkspaceReportServer reuses an already healthy server without spawning a new one', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;
  const originalSpawnProcess = reportServerManagerDependencies.spawnProcess;
  let spawnCalls = 0;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => ({
      status: 200,
      body: {
        status: 'ok',
        workspaceRoot: workspace.rootDir,
        artifactsDir: workspace.artifactsDir,
      },
    });
    reportServerManagerDependencies.spawnProcess = () => {
      spawnCalls += 1;
      return createSpawnedChild(9001);
    };

    const result = await startOrReuseWorkspaceReportServer({
      workspace,
      requestedPort: 4173,
    });

    assert.equal(result.reused, true);
    assert.equal(result.url, 'http://127.0.0.1:4173');
    assert.equal(spawnCalls, 0);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    reportServerManagerDependencies.spawnProcess = originalSpawnProcess;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('startOrReuseWorkspaceReportServer starts a new server, waits for health, and persists .server.json', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;
  const originalSpawnProcess = reportServerManagerDependencies.spawnProcess;
  const originalSleep = reportServerManagerDependencies.sleep;
  let healthChecks = 0;
  let spawnArgs: string[] = [];
  const requestedPort = await findAvailablePort();

  try {
    reportServerManagerDependencies.spawnProcess = (_command, args) => {
      spawnArgs = args;
      return createSpawnedChild(7331);
    };
    reportServerManagerDependencies.fetchJson = async () => {
      healthChecks += 1;
      if (healthChecks < 2) {
        throw new Error('booting');
      }
      return {
        status: 200,
        body: {
          status: 'ok',
          workspaceRoot: workspace.rootDir,
          artifactsDir: workspace.artifactsDir,
        },
      };
    };
    reportServerManagerDependencies.sleep = async () => {};

    const result = await startOrReuseWorkspaceReportServer({
      workspace,
      requestedPort,
    });

    assert.equal(result.reused, false);
    assert.equal(result.state.pid, 7331);
    assert.equal(result.state.port, requestedPort);
    assert.equal(result.url, `http://127.0.0.1:${requestedPort}`);
    assert.match(spawnArgs.join(' '), /internal-report-server/);
    const persisted = await readWorkspaceReportServerState(workspace);
    assert.equal(persisted?.port, requestedPort);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    reportServerManagerDependencies.spawnProcess = originalSpawnProcess;
    reportServerManagerDependencies.sleep = originalSleep;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('getWorkspaceReportServerStatus returns live running details and prefers the health-check pid', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => ({
      status: 200,
      body: {
        status: 'ok',
        workspaceRoot: workspace.rootDir,
        artifactsDir: workspace.artifactsDir,
        pid: 9001,
      },
    });

    const status = await getWorkspaceReportServerStatus(workspace);
    assert.equal(status.running, true);
    assert.equal(status.healthy, true);
    assert.equal(status.state?.pid, 9001);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('stopWorkspaceReportServer stops a healthy workspace server and removes stale state', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;
  const originalKillProcess = reportServerManagerDependencies.killProcess;
  const originalSleep = reportServerManagerDependencies.sleep;
  let healthChecks = 0;
  let killedPid = 0;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        return {
          status: 200,
          body: {
            status: 'ok',
            workspaceRoot: workspace.rootDir,
            artifactsDir: workspace.artifactsDir,
            pid: 7777,
          },
        };
      }
      throw new Error('connection refused');
    };
    reportServerManagerDependencies.killProcess = (pid) => {
      killedPid = pid;
    };
    reportServerManagerDependencies.sleep = async () => {};

    const result = await stopWorkspaceReportServer(workspace);
    assert.equal(result.stopped, true);
    assert.equal(killedPid, 7777);
    assert.equal(await readWorkspaceReportServerState(workspace), undefined);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    reportServerManagerDependencies.killProcess = originalKillProcess;
    reportServerManagerDependencies.sleep = originalSleep;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('stopWorkspaceReportServer refuses to kill a healthy server that does not report a live pid', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;
  const originalKillProcess = reportServerManagerDependencies.killProcess;
  let killCalls = 0;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => ({
      status: 200,
      body: {
        status: 'ok',
        workspaceRoot: workspace.rootDir,
        artifactsDir: workspace.artifactsDir,
      },
    });
    reportServerManagerDependencies.killProcess = () => {
      killCalls += 1;
    };

    await assert.rejects(
      () => stopWorkspaceReportServer(workspace),
      /live server did not report a pid/,
    );
    assert.equal(killCalls, 0);
    assert.notEqual(await readWorkspaceReportServerState(workspace), undefined);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    reportServerManagerDependencies.killProcess = originalKillProcess;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('stopWorkspaceReportServer is idempotent when the server is already down', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.fetchJson = async () => {
      throw new Error('connection refused');
    };

    const result = await stopWorkspaceReportServer(workspace);
    assert.equal(result.stopped, false);
    assert.equal(result.staleStateCleared, true);
    assert.equal(await readWorkspaceReportServerState(workspace), undefined);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('getWorkspaceReportServerStatus treats a timed-out health probe as stale state', async () => {
  const workspace = createWorkspace();
  const originalFetchJson = reportServerManagerDependencies.fetchJson;
  const originalHealthProbeTimeoutMs = reportServerManagerDependencies.healthProbeTimeoutMs;

  try {
    await writeWorkspaceReportServerState(workspace, createServerState(workspace));
    reportServerManagerDependencies.healthProbeTimeoutMs = 10;
    reportServerManagerDependencies.fetchJson = async (_url, signal) => {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      });
      throw new Error('unreachable');
    };

    const status = await getWorkspaceReportServerStatus(workspace);
    assert.equal(status.running, false);
    assert.equal(status.staleStateCleared, true);
    assert.equal(await readWorkspaceReportServerState(workspace), undefined);
  } finally {
    reportServerManagerDependencies.fetchJson = originalFetchJson;
    reportServerManagerDependencies.healthProbeTimeoutMs = originalHealthProbeTimeoutMs;
    await fsp.rm(workspace.rootDir, { recursive: true, force: true });
  }
});

test('openReportUrl delegates to the browser opener and buildRunReportUrl targets the run route', async () => {
  const originalOpenBrowser = reportServerManagerDependencies.openBrowser;
  let openedUrl = '';

  try {
    reportServerManagerDependencies.openBrowser = async (url: string) => {
      openedUrl = url;
    };

    const runUrl = buildRunReportUrl('http://127.0.0.1:4173', '2026-03-24T18-00-00.000Z-dev-android');
    await openReportUrl(runUrl);
    assert.equal(
      openedUrl,
      'http://127.0.0.1:4173/runs/2026-03-24T18-00-00.000Z-dev-android',
    );
  } finally {
    reportServerManagerDependencies.openBrowser = originalOpenBrowser;
  }
});
