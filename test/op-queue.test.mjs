import assert from 'node:assert/strict';
import test from 'node:test';
import { OpQueue } from '../dist/op-queue.js';

test('OpQueue executes operations sequentially', async () => {
  const queue = new OpQueue();
  const order = [];

  const createOp = (id, delayMs) => async () => {
    order.push(`${id} start`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    order.push(`${id} end`);
    return id;
  };

  const p1 = queue.run(createOp('A', 20));
  const p2 = queue.run(createOp('B', 10));

  await Promise.all([p1, p2]);

  assert.deepEqual(order, ['A start', 'A end', 'B start', 'B end']);
});

test('OpQueue executes subsequent operations even if one fails', async () => {
  const queue = new OpQueue();
  const order = [];

  const op1 = async () => {
    order.push('1 start');
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('1 fail');
    throw new Error('Test error');
  };

  const op2 = async () => {
    order.push('2 start');
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push('2 end');
    return 'success';
  };

  const p1 = queue.run(op1);
  const p2 = queue.run(op2);

  await assert.rejects(p1, /Test error/);
  const result = await p2;

  assert.equal(result, 'success');
  assert.deepEqual(order, ['1 start', '1 fail', '2 start', '2 end']);
});

test('OpQueue calls onError callback when an operation fails', async () => {
  let errorCount = 0;
  const queue = new OpQueue((err) => {
    errorCount++;
    assert.match(err.message, /Callback error/);
  });

  const p1 = queue.run(async () => {
    throw new Error('Callback error');
  });

  await assert.rejects(p1);
  assert.equal(errorCount, 1);
});

test('OpQueue returns the result of the operation', async () => {
  const queue = new OpQueue();
  const result = await queue.run(async () => 'expected result');
  assert.equal(result, 'expected result');
});
