import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import AdmZip from 'adm-zip';
import { submitRun, type SubmitRunInput } from './submit.js';

// Characterization tests: these pin submitRun's CURRENT behavior so the
// phase-extraction refactor provably preserves it. Only globalThis.fetch is
// stubbed (the one boundary that must not be crossed); all filesystem
// behavior — spec files, workspace config/env, app bundles, temp zips —
// runs against real temp directories.

const API_KEY = 'test-api-key-secret';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `finalrun-submit-test-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeSpecFile(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `# spec ${name}\n`);
  return filePath;
}

function makeWorkspace(opts: { config?: boolean; envFiles?: string[] } = {}): string {
  const root = makeTempDir('ws');
  if (opts.config) {
    fs.mkdirSync(path.join(root, '.finalrun'), { recursive: true });
    fs.writeFileSync(path.join(root, '.finalrun', 'config.yaml'), 'env: dev\n');
  }
  for (const envFile of opts.envFiles ?? []) {
    const envDir = path.join(root, '.finalrun', 'env');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, envFile), `# env ${envFile}\n`);
  }
  return root;
}

function makeInput(overrides: Partial<SubmitRunInput> = {}): SubmitRunInput {
  const specDir = makeTempDir('specs');
  const sourcePath = writeSpecFile(specDir, 'login.yaml');
  return {
    checked: { tests: [{ sourcePath, relativePath: 'login.yaml', name: 'Login flow' }] },
    workspaceRoot: makeWorkspace(),
    selectors: ['tests/login.yaml'],
    command: 'finalrun cloud test tests/login.yaml',
    cloudUrl: 'https://cloud.example',
    apiKey: API_KEY,
    ...overrides,
  };
}

interface CapturedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  form: FormData;
  signal?: AbortSignal | null;
}

function installFetchStub(respond: (req: CapturedRequest) => Response | Promise<Response>): {
  requests: CapturedRequest[];
  restore: () => void;
} {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const captured: CapturedRequest = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      form: init?.body as FormData,
      signal: init?.signal,
    };
    requests.push(captured);
    return respond(captured);
  }) as typeof fetch;
  return {
    requests,
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

function okResponse(runId = 'run-123'): Response {
  return new Response(JSON.stringify({ success: true, runId }), { status: 201 });
}

/** Names of submitRun/appBundle temp zip artifacts currently in os.tmpdir(). */
function tempZipArtifacts(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => /^finalrun-(cloud|app)-.*\.zip$/.test(name))
    .sort();
}

async function zipEntryNames(form: FormData): Promise<string[]> {
  const blob = form.get('file') as Blob;
  const zip = new AdmZip(Buffer.from(await blob.arrayBuffer()));
  return zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName)
    .sort();
}

test('submitRun posts a multipart submission to /api/v1/execute with bearer auth (server-default app mode)', async () => {
  const stub = installFetchStub(() => okResponse('run-42'));
  let result;
  try {
    result = await submitRun(makeInput({ platform: 'android' }));
  } finally {
    stub.restore();
  }

  assert.equal(stub.requests.length, 1);
  const req = stub.requests[0];
  assert.equal(req.url, 'https://cloud.example/api/v1/execute');
  assert.equal(req.method, 'POST');
  assert.deepEqual(req.headers, { Authorization: `Bearer ${API_KEY}` });
  assert.ok(req.signal instanceof AbortSignal, 'request carries a timeout signal');
  // Exact field enumeration: nothing beyond these is ever forwarded — in
  // particular no appFile/appFilename in server-default mode and no secrets.
  assert.deepEqual(
    [...req.form.keys()].sort(),
    ['command', 'file', 'name', 'platform', 'runType', 'selectors'],
  );
  assert.equal(req.form.get('command'), 'finalrun cloud test tests/login.yaml');
  assert.deepEqual(JSON.parse(req.form.get('selectors') as string), ['tests/login.yaml']);
  assert.equal(req.form.get('runType'), 'single_test');
  assert.equal(req.form.get('name'), 'Login flow');
  assert.equal(req.form.get('platform'), 'android');
  assert.deepEqual(result, {
    runId: 'run-42',
    statusUrl: 'https://cloud.example/runs/run-42',
    appFilename: undefined,
  });
});

test('submitRun tells the user which platform the server will auto-pick when --app is omitted', async () => {
  // Pins the one user-visible string reachable without intercepting ora's
  // dynamic ESM import. The three spinner strings (buildSpinnerMessage's two
  // branches and reportSubmitSuccess's succeed text) remain unpinned — see
  // plan.md for why closing that needs an ora seam.
  const stub = installFetchStub(() => okResponse());
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await submitRun(makeInput({ platform: 'ios' }));
  } finally {
    console.log = originalLog;
    stub.restore();
  }

  const notice = logged.find((line) => line.includes('No --app provided'));
  assert.ok(notice, 'server-default mode announces that the server picks the app');
  assert.match(notice, /server will use the latest app uploaded for/);
  assert.match(notice, /iOS|ios/);
});

test('submitRun forwards the documented non-secret variables map verbatim and never the API key', async () => {
  const stub = installFetchStub(() => okResponse());
  try {
    await submitRun(makeInput({ variables: { APP_ENV: 'staging', USERNAME: 'demo' } }));
  } finally {
    stub.restore();
  }

  const form = stub.requests[0].form;
  assert.equal(form.get('variables'), JSON.stringify({ APP_ENV: 'staging', USERNAME: 'demo' }));
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      assert.ok(!value.includes(API_KEY), `form field "${key}" must not leak the API key`);
    }
  }
});

test('submitRun omits the variables field when variables is undefined or empty', async () => {
  for (const variables of [undefined, {}]) {
    const stub = installFetchStub(() => okResponse());
    try {
      await submitRun(makeInput({ variables }));
    } finally {
      stub.restore();
    }
    assert.equal(stub.requests[0].form.has('variables'), false);
  }
});

test('submitRun uploads a supplied .apk via appFile fields and leaves the source file in place', async () => {
  const apkPath = path.join(makeTempDir('app'), 'myapp.apk');
  fs.writeFileSync(apkPath, Buffer.from('fake-apk-bytes'));
  const stub = installFetchStub(() => okResponse());
  let result;
  try {
    result = await submitRun(makeInput({ appPath: apkPath }));
  } finally {
    stub.restore();
  }

  const form = stub.requests[0].form;
  const appFile = form.get('appFile') as File;
  assert.equal(appFile.name, 'myapp.apk');
  assert.equal(Buffer.from(await appFile.arrayBuffer()).toString(), 'fake-apk-bytes');
  assert.equal(form.get('appFilename'), 'myapp.apk');
  assert.equal(result.appFilename, 'myapp.apk');
  assert.ok(fs.existsSync(apkPath), 'a non-temp .apk source must not be deleted by cleanup');
});

test('submitRun zips a .app directory for upload and removes both temp zips on success', async () => {
  const before = tempZipArtifacts();
  const bundlePath = path.join(makeTempDir('appdir'), 'MyApp.app');
  fs.mkdirSync(bundlePath);
  fs.writeFileSync(path.join(bundlePath, 'Info.plist'), 'plist');

  // The temp .app.zip is unlinked in submitRun's finally, so its streamed
  // blob must be read inside the stub while the file still exists.
  let appZipEntries: string[] = [];
  const stub = installFetchStub(async (req) => {
    const appFile = req.form.get('appFile') as File;
    const appZip = new AdmZip(Buffer.from(await appFile.arrayBuffer()));
    appZipEntries = appZip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.entryName);
    return okResponse();
  });
  let result;
  try {
    result = await submitRun(makeInput({ appPath: bundlePath }));
  } finally {
    stub.restore();
  }

  const form = stub.requests[0].form;
  assert.equal(form.get('appFilename'), 'MyApp.app.zip');
  assert.equal((form.get('appFile') as File).name, 'MyApp.app.zip');
  assert.deepEqual(appZipEntries, ['MyApp.app/Info.plist']);
  assert.equal(result.appFilename, 'MyApp.app.zip');
  assert.deepEqual(tempZipArtifacts(), before, 'spec zip and temp app zip must both be removed');
});

test('submitRun zips only the checked test specs when no config or env file exists', async () => {
  const stub = installFetchStub(() => okResponse());
  try {
    await submitRun(makeInput());
  } finally {
    stub.restore();
  }
  assert.deepEqual(await zipEntryNames(stub.requests[0].form), ['tests/login.yaml']);
});

test('submitRun ships the suite, config.yaml, and only the resolved env file', async () => {
  const workspaceRoot = makeWorkspace({ config: true, envFiles: ['dev.yaml', 'prod.yaml'] });
  const specDir = makeTempDir('specs');
  const testPath = writeSpecFile(specDir, 'login.yaml');
  const suiteSource = writeSpecFile(specDir, 'smoke.yaml');
  const input = makeInput({
    checked: {
      tests: [{ sourcePath: testPath, relativePath: 'login.yaml', name: 'Login flow' }],
      suite: { sourcePath: suiteSource, relativePath: 'smoke.yaml', name: 'Smoke suite' },
    },
    workspaceRoot,
    suitePath: 'suites/smoke.yaml',
    envName: 'dev',
  });
  const stub = installFetchStub(() => okResponse());
  try {
    await submitRun(input);
  } finally {
    stub.restore();
  }

  const form = stub.requests[0].form;
  // env/prod.yaml is deliberately absent: only the resolved env file ships.
  assert.deepEqual(await zipEntryNames(form), [
    'config.yaml',
    'env/dev.yaml',
    'suites/smoke.yaml',
    'tests/login.yaml',
  ]);
  assert.equal(form.get('runType'), 'suite');
  assert.equal(form.get('name'), 'Smoke suite');
  assert.equal(form.get('suitePath'), 'suites/smoke.yaml');
  assert.equal(form.get('envName'), 'dev');
});

test('submitRun falls back to the .yml env file when no .yaml candidate exists', async () => {
  const workspaceRoot = makeWorkspace({ envFiles: ['stage.yml'] });
  const stub = installFetchStub(() => okResponse());
  try {
    await submitRun(makeInput({ workspaceRoot, envName: 'stage' }));
  } finally {
    stub.restore();
  }
  assert.deepEqual(await zipEntryNames(stub.requests[0].form), [
    'env/stage.yml',
    'tests/login.yaml',
  ]);
});

test('submitRun labels multi-test runs "<first> + N more" with runType multi_test', async () => {
  const specDir = makeTempDir('specs');
  const tests = ['a.yaml', 'b.yaml', 'c.yaml'].map((name, index) => ({
    sourcePath: writeSpecFile(specDir, name),
    relativePath: name,
    name: `Test ${index + 1}`,
  }));
  const stub = installFetchStub(() => okResponse());
  try {
    await submitRun(makeInput({ checked: { tests } }));
  } finally {
    stub.restore();
  }

  const form = stub.requests[0].form;
  assert.equal(form.get('runType'), 'multi_test');
  assert.equal(form.get('name'), 'Test 1 + 2 more');
});

test('submitRun throws with status and body on a non-201 response and still removes the spec zip', async () => {
  const before = tempZipArtifacts();
  const stub = installFetchStub(() => new Response('backend exploded', { status: 400 }));
  try {
    await assert.rejects(submitRun(makeInput()), /Cloud service returned 400: backend exploded/);
  } finally {
    stub.restore();
  }
  assert.deepEqual(tempZipArtifacts(), before);
});

test('submitRun propagates a fetch failure and removes the spec zip and temp app zip', async () => {
  const before = tempZipArtifacts();
  const bundlePath = path.join(makeTempDir('appdir'), 'Crashy.app');
  fs.mkdirSync(bundlePath);
  fs.writeFileSync(path.join(bundlePath, 'Info.plist'), 'plist');
  const stub = installFetchStub(() => Promise.reject(new Error('network down')));
  try {
    await assert.rejects(submitRun(makeInput({ appPath: bundlePath })), /network down/);
  } finally {
    stub.restore();
  }
  assert.deepEqual(tempZipArtifacts(), before, 'failure path must clean up both temp zips');
});

test('submitRun throws when the server responds 201 but rejects the submission', async () => {
  const body = JSON.stringify({ success: false, error: 'quota exceeded' });
  const stub = installFetchStub(() => new Response(body, { status: 201 }));
  try {
    await assert.rejects(submitRun(makeInput()), /Cloud submission failed: quota exceeded/);
  } finally {
    stub.restore();
  }
});

test('submitRun surfaces an unparseable 201 body as a rejection', async () => {
  const stub = installFetchStub(() => new Response('<html>proxy says hi</html>', { status: 201 }));
  try {
    await assert.rejects(submitRun(makeInput()), SyntaxError);
  } finally {
    stub.restore();
  }
});

test('the module throws at load time when FINALRUN_SUBMIT_TIMEOUT_MS is invalid', () => {
  // SUBMIT_TIMEOUT_MS is a module-level const evaluated on first load, so the
  // validation throw is only reachable by re-evaluating the module. The
  // package compiles to CommonJS, so the require cache is the fresh-instance
  // seam; the statically imported submitRun binding above is unaffected.
  const original = process.env['FINALRUN_SUBMIT_TIMEOUT_MS'];
  const modulePath = require.resolve('./submit.js');
  const reload = (): void => {
    delete require.cache[modulePath];
    require(modulePath);
  };
  try {
    for (const invalid of ['not-a-number', '0', '-5000']) {
      process.env['FINALRUN_SUBMIT_TIMEOUT_MS'] = invalid;
      assert.throws(reload, /Invalid FINALRUN_SUBMIT_TIMEOUT_MS/, `expected throw for "${invalid}"`);
    }
    process.env['FINALRUN_SUBMIT_TIMEOUT_MS'] = '60000';
    assert.doesNotThrow(reload, 'a valid override must be accepted');
  } finally {
    if (original === undefined) {
      delete process.env['FINALRUN_SUBMIT_TIMEOUT_MS'];
    } else {
      process.env['FINALRUN_SUBMIT_TIMEOUT_MS'] = original;
    }
    delete require.cache[modulePath];
  }
});
