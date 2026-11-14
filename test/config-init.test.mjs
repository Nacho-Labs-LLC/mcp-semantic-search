import assert from 'node:assert/strict';
import test from 'node:test';

import { getConfig, parseCorruptStoreMode, resolveDeduplicate } from '../dist/config.js';
import { initWithRetry } from '../dist/init.js';

const cfg = (env = {}) => getConfig([], env);

test('dedup env mapping: defaults give { similarity: 0.95 }', () => {
  assert.deepEqual(cfg().deduplicate, { similarity: 0.95 });
});

test('dedup env mapping covers similarity, exact-only and off', () => {
  assert.deepEqual(resolveDeduplicate(false, 0.8), { similarity: 0.8 });
  assert.equal(resolveDeduplicate(true, 0), 'normalized');
  assert.equal(resolveDeduplicate(false, 0), 'off');
  assert.equal(cfg({ MCP_SEMANTIC_DEDUPLICATE_SIMILARITY: '0' }).deduplicate, 'normalized');
  assert.equal(
    cfg({ MCP_SEMANTIC_DEDUPLICATE_SIMILARITY: '0', MCP_SEMANTIC_DEDUPLICATE_EXACT: 'false' }).deduplicate,
    'off',
  );
  assert.deepEqual(cfg({ MCP_SEMANTIC_DEDUPLICATE_EXACT: 'false' }).deduplicate, { similarity: 0.95 });
  assert.equal(resolveDeduplicate(true, Number.NaN), 'normalized');
});

test('cache dir defaults to undefined (library per-user cache) and honors the override', () => {
  assert.equal(cfg().cacheDir, undefined);
  assert.equal(cfg({ MCP_SEMANTIC_CACHE_DIR: '/x/y' }).cacheDir, '/x/y');
});

test('MCP_SEMANTIC_ON_CORRUPT_STORE defaults to throw, accepts quarantine, rejects junk', () => {
  assert.equal(cfg().onCorruptStore, 'throw');
  assert.equal(cfg({ MCP_SEMANTIC_ON_CORRUPT_STORE: 'quarantine' }).onCorruptStore, 'quarantine');
  assert.throws(() => cfg({ MCP_SEMANTIC_ON_CORRUPT_STORE: 'delete' }), /MCP_SEMANTIC_ON_CORRUPT_STORE/);
  assert.throws(() => parseCorruptStoreMode(''), /Expected/);
});

function corruptError() {
  const err = new Error('Unexpected token } in JSON');
  err.name = 'StoreCorruptError';
  err.path = '/data/store.json';
  return err;
}

test('corrupt store: no retry, actionable message, error propagates', async () => {
  let calls = 0;
  const logs = [];
  const search = {
    init: async () => {
      calls++;
      throw corruptError();
    },
    size: () => 0,
  };
  await assert.rejects(
    initWithRetry({
      search,
      storePath: '/fallback.json',
      verbose: false,
      retryDelayMs: 1,
      log: (...a) => logs.push(a.join(' ')),
    }),
    { name: 'StoreCorruptError' },
  );
  assert.equal(calls, 1);
  const out = logs.join('\n');
  assert.match(out, /\/data\/store\.json/);
  assert.match(out, /repair|delete/i);
  assert.match(out, /MCP_SEMANTIC_ON_CORRUPT_STORE=quarantine/);
  assert.doesNotMatch(out, /Internet required/i);
});

test('other errors still retry, then fail without claiming a network cause', async () => {
  let calls = 0;
  const logs = [];
  const search = {
    init: async () => {
      calls++;
      throw new Error('EACCES: permission denied');
    },
    size: () => 0,
  };
  await assert.rejects(
    initWithRetry({ search, storePath: 's', verbose: false, retryDelayMs: 1, log: (...a) => logs.push(a.join(' ')) }),
    /EACCES/,
  );
  assert.equal(calls, 3);
  const out = logs.join('\n');
  assert.match(out, /EACCES/);
  assert.match(out, /one possible cause/);
  assert.doesNotMatch(out, /Internet required/i);
});

test('init succeeds after a transient failure', async () => {
  let calls = 0;
  const search = {
    init: async () => {
      if (++calls < 2) throw new Error('transient');
    },
    size: () => 0,
  };
  await initWithRetry({ search, storePath: 's', verbose: false, retryDelayMs: 1, log: () => {} });
  assert.equal(calls, 2);
});
