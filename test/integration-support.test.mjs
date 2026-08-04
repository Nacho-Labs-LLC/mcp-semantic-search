import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { captureBoundedStderr, formatErrorWithDiagnostics, runWithCleanup } from './integration-support.mjs';

test('captureBoundedStderr retains a bounded tail of server stderr', () => {
  const stream = new EventEmitter();
  const stderr = captureBoundedStderr(stream, 12);

  stream.emit('data', Buffer.from('first-line\n'));
  stream.emit('data', Buffer.from('second-line\n'));

  assert.equal(stderr.read(), 'second-line\n');
});

test('formatErrorWithDiagnostics preserves the original failure as its cause', () => {
  const cause = new Error('MCP request timed out');
  const error = formatErrorWithDiagnostics(cause, 'server started\nmodel download failed');

  assert.equal(error.cause, cause);
  assert.match(error.message, /MCP request timed out/);
  assert.match(error.message, /Server stderr/);
  assert.match(error.message, /model download failed/);
});

test('runWithCleanup removes temporary resources even when client close rejects', async () => {
  const primaryFailure = new Error('search assertion failed');
  let removed = false;

  await assert.rejects(
    runWithCleanup(
      async () => {
        throw primaryFailure;
      },
      async () => {
        try {
          throw new Error('client close failed');
        } finally {
          removed = true;
        }
      },
    ),
    (error) => {
      assert.equal(error, primaryFailure);
      assert.match(error.message, /Cleanup failed: client close failed/);
      return true;
    },
  );

  assert.equal(removed, true);
});
