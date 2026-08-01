import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverEntry = join(repositoryRoot, 'dist', 'index.js');

test('serves semantic search over the MCP stdio transport', { timeout: 180_000 }, async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mcp-semantic-search-'));
  const storePath = join(temporaryDirectory, 'store.json');
  const cacheDirectory = join(temporaryDirectory, 'transformers-cache');
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
  const client = new Client({ name: 'mcp-semantic-search-smoke-test', version: '1.0.0' });

  try {
    await client.connect(transport);

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

    const searched = await client.callTool({
      name: 'semantic_search',
      arguments: { query: 'retrieves smoke coverage document', limit: 1, minSimilarity: 0 },
    });
    assert.match(searched.content[0]?.text ?? '', /stdio-smoke-document|Semantic search smoke coverage/);
  } finally {
    await client.close();
    await transport.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
