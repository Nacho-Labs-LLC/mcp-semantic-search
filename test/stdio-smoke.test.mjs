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

async function runSmokeAttempt() {
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
  const stderr = captureBoundedStderr(transport.stderr);
  const client = new Client({ name: 'mcp-semantic-search-integration-test', version: '1.0.0' });
  let connected = false;

  return runWithCleanup(
    async () => {
      try {
        await client.connect(transport);
        connected = true;

        const { tools } = await client.listTools();
        assert.deepEqual(
          ['semantic_health', 'semantic_index', 'semantic_search'].every((name) =>
            tools.some((tool) => tool.name === name),
          ),
          true,
          'the server exposes the health, index, and search tools',
        );

        const health = await client.callTool({ name: 'semantic_health', arguments: {} });
        assert.match(health.content[0]?.text ?? '', /Healthy/);

        const indexed = await client.callTool({
          name: 'semantic_index',
          arguments: {
            id: 'stdio-smoke-document',
            text: 'Semantic search smoke coverage indexes and retrieves this document.',
            metadata: { kind: 'test', tags: ['smoke'] },
          },
        });
        assert.match(indexed.content[0]?.text ?? '', /Indexed/);

        const { resources } = await client.listResources();
        assert.deepEqual(resources.map((resource) => resource.uri).sort(), [
          'semantic-search://indexes/default/manifest',
          'semantic-search://indexes/default/stats',
        ]);
        assert.equal(client.getServerCapabilities()?.resources?.listChanged, undefined);

        const { resourceTemplates } = await client.listResourceTemplates();
        assert.deepEqual(
          resourceTemplates.map((template) => template.uriTemplate),
          ['semantic-search://indexes/{indexId}/documents/{documentId}'],
        );

        const manifest = await client.readResource({ uri: 'semantic-search://indexes/default/manifest' });
        const stats = await client.readResource({ uri: 'semantic-search://indexes/default/stats' });
        const document = await client.readResource({
          uri: 'semantic-search://indexes/default/documents/stdio-smoke-document',
        });
        assert.equal(JSON.parse(manifest.contents[0]?.text ?? '{}').documentCount, 1);
        assert.equal(JSON.parse(stats.contents[0]?.text ?? '{}').counts.documents, 1);
        assert.equal(JSON.parse(document.contents[0]?.text ?? '{}').id, 'stdio-smoke-document');

        const searched = await client.callTool({
          name: 'semantic_search',
          arguments: { query: 'retrieves smoke coverage document', limit: 1, minSimilarity: 0 },
        });
        assert.match(searched.content[0]?.text ?? '', /stdio-smoke-document|Semantic search smoke coverage/);
        const resourceLinks = searched.content.filter((block) => block.type === 'resource_link');
        assert.deepEqual(
          resourceLinks.map((block) => block.uri),
          ['semantic-search://indexes/default/documents/stdio-smoke-document'],
        );
      } catch (error) {
        throw formatErrorWithDiagnostics(error, stderr.read());
      }
    },
    async () => {
      try {
        if (connected) {
          await client.close();
        }
      } finally {
        stderr.dispose();
        await rm(temporaryDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 200 });
      }
    },
  );
}

test('serves semantic search over the compiled MCP stdio transport', { timeout: 300_000 }, async () => {
  await retryIntegration(runSmokeAttempt, { attempts: 2, delayMs: 2_000 });
});
