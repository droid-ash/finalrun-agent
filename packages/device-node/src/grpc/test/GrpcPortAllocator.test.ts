import assert from 'node:assert/strict';
import test from 'node:test';
import { GrpcPortAllocator } from '../GrpcPortAllocator.js';

test('GrpcPortAllocator hands out distinct ports to distinct keys', async () => {
  const allocator = new GrpcPortAllocator({
    rangeStart: 60000,
    rangeEnd: 60003,
    isPortBindable: async () => true,
  });

  const a = await allocator.allocate('device-A');
  const b = await allocator.allocate('device-B');
  const c = await allocator.allocate('device-C');

  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
  assert.deepEqual(new Set([a, b, c]), new Set([60000, 60001, 60002]));
});

test('GrpcPortAllocator returns the same port on repeated allocation for one key', async () => {
  const allocator = new GrpcPortAllocator({
    rangeStart: 60100,
    rangeEnd: 60110,
    isPortBindable: async () => true,
  });

  const first = await allocator.allocate('device-A');
  const second = await allocator.allocate('device-A');

  assert.equal(first, second);
});

test('GrpcPortAllocator skips ports the kernel reports as not bindable', async () => {
  let calls = 0;
  const allocator = new GrpcPortAllocator({
    rangeStart: 60200,
    rangeEnd: 60205,
    isPortBindable: async (port) => {
      calls += 1;
      return port !== 60200 && port !== 60201;
    },
  });

  const port = await allocator.allocate('device-A');
  assert.equal(port, 60202);
  assert.equal(calls, 3);
});

test('GrpcPortAllocator throws when the range is exhausted', async () => {
  const allocator = new GrpcPortAllocator({
    rangeStart: 60300,
    rangeEnd: 60302,
    isPortBindable: async () => true,
  });

  await allocator.allocate('device-A');
  await allocator.allocate('device-B');

  await assert.rejects(
    () => allocator.allocate('device-C'),
    /No gRPC ports available in range 60300-60302/,
  );
});

test('GrpcPortAllocator returns a released port to the pool', async () => {
  const allocator = new GrpcPortAllocator({
    rangeStart: 60400,
    rangeEnd: 60402,
    isPortBindable: async () => true,
  });

  const a = await allocator.allocate('device-A');
  const b = await allocator.allocate('device-B');
  await allocator.release('device-A');

  const c = await allocator.allocate('device-C');
  assert.equal(c, a);
  assert.notEqual(c, b);
});

test('GrpcPortAllocator serializes concurrent allocations', async () => {
  const allocator = new GrpcPortAllocator({
    rangeStart: 60500,
    rangeEnd: 60505,
    isPortBindable: async () => true,
  });

  const ports = await Promise.all([
    allocator.allocate('A'),
    allocator.allocate('B'),
    allocator.allocate('C'),
    allocator.allocate('D'),
  ]);

  assert.equal(new Set(ports).size, 4, 'each concurrent allocator should get a unique port');
});

test('GrpcPortAllocator clear drops every reservation', async () => {
  const allocator = new GrpcPortAllocator({
    rangeStart: 60600,
    rangeEnd: 60603,
    isPortBindable: async () => true,
  });

  await allocator.allocate('A');
  await allocator.allocate('B');
  await allocator.clear();

  assert.equal(allocator.getPort('A'), undefined);
  assert.equal(allocator.getPort('B'), undefined);

  const reAllocated = await allocator.allocate('C');
  assert.equal(reAllocated, 60600);
});
