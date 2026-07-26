import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  GrpcDriverClient,
  GrpcRawScreenshotResponse,
  GrpcScreenshotResponse,
} from '../../grpc/GrpcDriverClient.js';
import { DeviceSession } from '../DeviceSession.js';
import {
  isTransientCaptureFailureMessage,
  ScreenshotCaptureHelper,
} from '../ScreenshotCapture.js';

class FakeGrpcClient {
  captureCalls = 0;
  rawScreenshotCalls = 0;
  captureResponses: Array<GrpcScreenshotResponse | Error>;
  rawScreenshotResponses: Array<GrpcRawScreenshotResponse | Error>;

  constructor(params?: {
    captureResponses?: Array<GrpcScreenshotResponse | Error>;
    rawScreenshotResponses?: Array<GrpcRawScreenshotResponse | Error>;
  }) {
    this.captureResponses = params?.captureResponses ?? [];
    this.rawScreenshotResponses = params?.rawScreenshotResponses ?? [];
  }

  async getScreenshotAndHierarchy(): Promise<GrpcScreenshotResponse> {
    this.captureCalls += 1;
    const next =
      this.captureResponses.shift() ??
      new Error('No capture response configured');
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async getRawScreenshot(): Promise<GrpcRawScreenshotResponse> {
    this.rawScreenshotCalls += 1;
    const next =
      this.rawScreenshotResponses.shift() ??
      new Error('No raw screenshot response configured');
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

test('isTransientCaptureFailureMessage matches UiAutomation-adjacent NPE variants', () => {
  // The Android driver's stale-binding failures surface either as the clean
  // "UiAutomation not connected" message or as a JVM NPE from framework code.
  // Both shapes need to count as transient so `waitForCaptureReadiness` gets
  // to retry inside its window instead of bailing on the first poll.
  assert.equal(
    isTransientCaptureFailureMessage(
      "Attempt to invoke virtual method 'java.lang.Class java.lang.Object.getClass()' on a null object reference",
    ),
    true,
  );
  assert.equal(
    isTransientCaptureFailureMessage(
      'java.lang.NullPointerException: Attempt to read from field ...',
    ),
    true,
  );
  assert.equal(
    isTransientCaptureFailureMessage('Invalid hierarchy JSON from driver'),
    true,
  );
  assert.equal(
    isTransientCaptureFailureMessage('device offline'),
    false,
  );
});

test('ScreenshotCaptureHelper retries transient failures when stability is disabled', async () => {
  const session = new DeviceSession();
  session.setShouldEnsureStability(false);

  const grpcClient = new FakeGrpcClient({
    captureResponses: [
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
      {
        success: true,
        screenshot: 'base64-image',
        hierarchy: '[]',
        screenWidth: 1080,
        screenHeight: 2400,
      },
    ],
  });

  const helper = new ScreenshotCaptureHelper({
    grpcClient: grpcClient as unknown as GrpcDriverClient,
    session,
  });

  const response = await helper.capture();
  const captureTrace = response.data?.['captureTrace'] as Record<string, unknown>;

  assert.equal(response.success, true);
  assert.equal(grpcClient.captureCalls, 3);
  assert.equal(response.data?.['screenshot'], 'base64-image');
  assert.equal(response.data?.['screenWidth'], 1080);
  assert.equal(captureTrace['attempts'], 3);
  assert.equal(captureTrace['stable'], false);
  assert.equal(captureTrace['pollCount'], 0);
  assert.equal(typeof captureTrace['totalMs'], 'number');
  assert.equal(typeof captureTrace['finalPayloadMs'], 'number');
});

test('ScreenshotCaptureHelper waits for stable raw screenshots before final capture', async () => {
  const session = new DeviceSession();
  session.setShouldEnsureStability(true);

  const grpcClient = new FakeGrpcClient({
    rawScreenshotResponses: [
      {
        success: true,
        screenshot: Buffer.from('frame-a'),
        screenWidth: 1080,
        screenHeight: 2400,
      },
      {
        success: true,
        screenshot: Buffer.from('frame-a'),
        screenWidth: 1080,
        screenHeight: 2400,
      },
    ],
    captureResponses: [
      {
        success: true,
        screenshot: 'stable-image',
        hierarchy: '[]',
        screenWidth: 1080,
        screenHeight: 2400,
      },
    ],
  });

  const helper = new ScreenshotCaptureHelper({
    grpcClient: grpcClient as unknown as GrpcDriverClient,
    session,
  });

  const response = await helper.capture();
  const captureTrace = response.data?.['captureTrace'] as Record<string, unknown>;

  assert.equal(response.success, true);
  assert.equal(grpcClient.rawScreenshotCalls, 2);
  assert.equal(grpcClient.captureCalls, 1);
  assert.equal(response.data?.['screenshot'], 'stable-image');
  assert.equal(captureTrace['attempts'], 1);
  assert.equal(captureTrace['stable'], true);
  assert.equal(captureTrace['pollCount'], 2);
  assert.equal(typeof captureTrace['stabilityMs'], 'number');
  assert.equal(typeof captureTrace['finalPayloadMs'], 'number');
});

test('ScreenshotCaptureHelper exhausts retries on invalid hierarchy payloads', async () => {
  const session = new DeviceSession();
  session.setShouldEnsureStability(false);

  const grpcClient = new FakeGrpcClient({
    captureResponses: [
      {
        success: true,
        screenshot: 'base64-image',
        hierarchy: 'not-json',
        screenWidth: 1080,
        screenHeight: 2400,
      },
      {
        success: true,
        screenshot: 'base64-image',
        hierarchy: 'not-json',
        screenWidth: 1080,
        screenHeight: 2400,
      },
      {
        success: true,
        screenshot: 'base64-image',
        hierarchy: 'not-json',
        screenWidth: 1080,
        screenHeight: 2400,
      },
    ],
  });

  const helper = new ScreenshotCaptureHelper({
    grpcClient: grpcClient as unknown as GrpcDriverClient,
    session,
  });

  const response = await helper.capture();
  const captureTrace = response.data?.['captureTrace'] as Record<string, unknown>;

  assert.equal(response.success, false);
  assert.equal(response.message, 'Invalid hierarchy JSON from driver');
  assert.equal(grpcClient.captureCalls, 3);
  assert.equal(captureTrace['attempts'], 3);
  assert.equal(captureTrace['failureReason'], 'Invalid hierarchy JSON from driver');
  assert.equal(typeof captureTrace['totalMs'], 'number');
});
