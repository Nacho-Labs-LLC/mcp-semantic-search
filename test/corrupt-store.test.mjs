import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverEntry = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'dist', 'index.js');

function run(env, { closeAfterMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    if (closeAfterMs) setTimeout(() => child.kill(), closeAfterMs);
    child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
  });
}

test('a corrupt store file exits non-zero with an actionable message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-corrupt-'));
  try {
    const storePath = join(dir, 'store.json');
    await writeFile(storePath, '{ not json');
    const { code, stderr } = await run({
      MCP_SEMANTIC_STORE: storePath,
      MCP_SEMANTIC_CACHE_DIR: process.env.MCP_SEMANTIC_TEST_CACHE_DIR ?? join(dir, 'cache'),
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes(storePath), stderr);
    assert.match(stderr, /MCP_SEMANTIC_ON_CORRUPT_STORE=quarantine/);
    assert.doesNotMatch(stderr, /Retry in 2s/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP_SEMANTIC_ON_CORRUPT_STORE=quarantine renames the file aside and starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-quarantine-'));
  try {
    const storePath = join(dir, 'store.json');
    await writeFile(storePath, '{ not json');
    const { code, signal } = await run(
      {
        MCP_SEMANTIC_STORE: storePath,
        MCP_SEMANTIC_ON_CORRUPT_STORE: 'quarantine',
        MCP_SEMANTIC_CACHE_DIR: process.env.MCP_SEMANTIC_TEST_CACHE_DIR ?? join(dir, 'cache'),
      },
      { closeAfterMs: 8000 },
    );
    assert.notEqual(code, 1, 'server should have started and been killed by the test, not exited 1');
    assert.equal(signal, 'SIGTERM');
    const files = await readdir(dir);
    assert.ok(
      files.some((f) => f !== 'store.json' && f.startsWith('store.json')),
      files.join(','),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid MCP_SEMANTIC_ON_CORRUPT_STORE value exits non-zero', async () => {
  const { code, stderr } = await run({ MCP_SEMANTIC_ON_CORRUPT_STORE: 'bogus' });
  assert.equal(code, 1);
  assert.match(stderr, /MCP_SEMANTIC_ON_CORRUPT_STORE/);
});
