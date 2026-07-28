// Characterization tests for the SPA fetch helpers. globalThis.fetch is the
// only boundary these cross; it is stubbed per test and restored in a
// finally, per the repo's characterize-around-the-absent-seam pattern.

import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReportIndex, fetchReportRun } from '../fetchers';

interface RecordedCall {
  url: string;
  headers: unknown;
}

function stubFetch(
  response: { ok: boolean; status?: number; statusText?: string; body?: unknown },
  calls: RecordedCall[],
): typeof fetch {
  const impl = async (input: unknown, init?: { headers?: unknown }) => {
    calls.push({ url: String(input), headers: init?.headers });
    return {
      ok: response.ok,
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      json: async () => response.body,
    };
  };
  return impl as unknown as typeof fetch;
}

test('fetchReportIndex requests /api/report/index with an Accept header', async () => {
  const calls: RecordedCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ ok: true, body: { runs: [] } }, calls);
  try {
    const result = await fetchReportIndex();
    assert.deepEqual(result, { runs: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/report/index');
    assert.deepEqual(calls[0]?.headers, { Accept: 'application/json' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchReportIndex throws with status and statusText on a non-ok response', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ ok: false, status: 500, statusText: 'Internal Server Error' }, []);
  try {
    await assert.rejects(
      fetchReportIndex(),
      new Error('Failed to load report index (500 Internal Server Error)'),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchReportRun URI-encodes the run id into the endpoint path', async () => {
  const calls: RecordedCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ ok: true, body: { run: { runId: 'run 42/x' } } }, calls);
  try {
    const result = await fetchReportRun('run 42/x');
    assert.deepEqual(result, { run: { runId: 'run 42/x' } });
    assert.equal(calls[0]?.url, '/api/report/runs/run%2042%2Fx');
    assert.deepEqual(calls[0]?.headers, { Accept: 'application/json' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchReportRun throws with the raw run id, status, and statusText', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ ok: false, status: 404, statusText: 'Not Found' }, []);
  try {
    await assert.rejects(
      fetchReportRun('my-run'),
      new Error('Failed to load run my-run (404 Not Found)'),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
