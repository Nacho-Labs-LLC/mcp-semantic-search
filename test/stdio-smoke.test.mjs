import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  captureBoundedStderr,
  formatErrorWithDiagnostics,
  retryIntegration,
  runWithCleanup,
} from './integration-support.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverEntry = join(repositoryRoot, 'dist', 'index.js');

async function createSmokeServer() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mcp-semantic-search-'));
  const storePath = join(temporaryDirectory, 'store.json');
  // Local runs use an isolated cache that is removed with the test. Release CI
  // supplies a cache outside the checkout so model downloads can be reused.
  const cacheDirectory = process.env.MCP_SEMANTIC_TEST_CACHE_DIR ?? join(temporaryDirectory, 'transformers-cache');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      MCP_SEMANTIC_STORE: storePath,
      MCP_SEMANTIC_CACHE_DIR: cacheDirectory,
      MCP_SEMANTIC_SIMILARITY: '0',
    },
    stderr: 'pipe',
  });

  return { temporaryDirectory, transport };
}

async function assertToolsAreAvailable(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(
    ['semantic_health', 'semantic_index', 'semantic_search'].every((name) => tools.some((tool) => tool.name === name)),
    true,
    'the server exposes the health, index, and search tools',
  );
}

async function assertHealthIsAvailable(client) {
  const health = await client.callTool({ name: 'semantic_health', arguments: {} });
  assert.match(health.content[0]?.text ?? '', /Healthy/);
}

async function indexSmokeDocument(client) {
  const indexed = await client.callTool({
    name: 'semantic_index',
    arguments: {
      id: 'stdio-smoke-document',
      text: 'Semantic search smoke coverage indexes and retrieves this document.',
      metadata: { kind: 'test', tags: ['smoke'], timestamp: Date.now() },
    },
  });
  assert.match(indexed.content[0]?.text ?? '', /Indexed/);
}

async function assertFilteredSearchFindsDocument(client) {
  const searched = await client.callTool({
    name: 'semantic_search',
    arguments: {
      query: 'retrieves smoke coverage document',
      kind: 'test',
      tags: ['smoke'],
      since: '1970-01-01T00:00:00.000Z',
      limit: 1,
      minSimilarity: 0,
    },
  });
  assert.match(searched.content[0]?.text ?? '', /stdio-smoke-document|Semantic search smoke coverage/);
}

async function exerciseSmokeServer(client, transport, stderr, state) {
  try {
    await client.connect(transport);
    state.connected = true;
    await assertToolsAreAvailable(client);
    await assertHealthIsAvailable(client);
    await indexSmokeDocument(client);
    await assertFilteredSearchFindsDocument(client);
  } catch (error) {
    throw formatErrorWithDiagnostics(error, stderr.read());
  }
}

async function cleanupSmokeServer(client, stderr, temporaryDirectory, state) {
  try {
    if (state.connected) {
      await client.close();
    }
  } finally {
    stderr.dispose();
    await rm(temporaryDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
  }
}

async function runSmokeAttempt() {
  const { temporaryDirectory, transport } = await createSmokeServer();
  const stderr = captureBoundedStderr(transport.stderr);
  const client = new Client({ name: 'mcp-semantic-search-integration-test', version: '1.0.0' });
  const state = { connected: false };

  return runWithCleanup(
    () => exerciseSmokeServer(client, transport, stderr, state),
    () => cleanupSmokeServer(client, stderr, temporaryDirectory, state),
  );
}

test('serves semantic search over the compiled MCP stdio transport', { timeout: 300_000 }, async () => {
  await retryIntegration(runSmokeAttempt, { attempts: 2, delayMs: 2_000 });
});
