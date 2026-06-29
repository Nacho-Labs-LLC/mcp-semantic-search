import { test } from 'node:test';
import assert from 'node:assert';
import { OpQueue } from './queue.js';

test('OpQueue executes tasks sequentially', async () => {
  const queue = new OpQueue();
  const results: number[] = [];

  const p1 = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 50));
    results.push(1);
    return 1;
  });

  const p2 = queue.run(async () => {
    results.push(2);
    return 2;
  });

  await Promise.all([p1, p2]);
  assert.deepStrictEqual(results, [1, 2]);
});

test('OpQueue resolves with correct values', async () => {
  const queue = new OpQueue();

  const p1 = queue.run(async () => 'a');
  const p2 = queue.run(async () => 'b');

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.strictEqual(r1, 'a');
  assert.strictEqual(r2, 'b');
});

test('OpQueue rejects with correct error', async () => {
  const queue = new OpQueue();

  const promise = queue.run(async () => {
    throw new Error('Task failed');
  });

  await assert.rejects(promise, { message: 'Task failed' });
});

test('OpQueue handles errors without breaking queue', async () => {
  const queue = new OpQueue();
  const results: number[] = [];

  const p1 = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 10));
    throw new Error('fail');
  });

  const p2 = queue.run(async () => {
    results.push(2);
    return 2;
  });

  await p1.catch(() => {});
  await p2;
  assert.deepStrictEqual(results, [2]);
});

test('OpQueue calls onError when a task fails', async () => {
  let errorCalled = false;
  let receivedError: unknown;

  const queue = new OpQueue((err) => {
    errorCalled = true;
    receivedError = err;
  });

  const p1 = queue.run(async () => {
    throw new Error('trigger error callback');
  });

  await assert.rejects(p1);

  assert.strictEqual(errorCalled, true);
  assert.ok(receivedError instanceof Error);
  assert.strictEqual(receivedError.message, 'trigger error callback');
});
