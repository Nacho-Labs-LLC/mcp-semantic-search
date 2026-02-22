#!/usr/bin/env node

/**
 * MCP Semantic Search Server
 *
 * Gives AI tools (Claude Code, Cursor, etc.) persistent semantic memory
 * powered by local vector embeddings. No API keys, no cloud, no costs.
 *
 * Usage:
 *   npx @nacho-labs/mcp-semantic-search
 *   npx @nacho-labs/mcp-semantic-search --store /path/to/store.json
 *   npx @nacho-labs/mcp-semantic-search --similarity 0.5
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SemanticSearch } from '@nacho-labs/nachos-embeddings';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// --- Configuration via CLI args and env vars ---

function getConfig() {
  const args = process.argv.slice(2);

  function getArg(name: string, fallback: string): string {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1]!;
    }
    return fallback;
  }

  const storePath = resolve(
    process.env['MCP_SEMANTIC_STORE'] ??
    getArg('store', '.semantic-store.json')
  );

  const minSimilarity = parseFloat(
    process.env['MCP_SEMANTIC_SIMILARITY'] ??
    getArg('similarity', '0.6')
  );

  const model =
    process.env['MCP_SEMANTIC_MODEL'] ??
    getArg('model', 'Xenova/all-MiniLM-L6-v2');

  const cacheDir =
    process.env['MCP_SEMANTIC_CACHE_DIR'] ??
    getArg('cache-dir', '.cache/transformers');

  return { storePath, minSimilarity, model, cacheDir };
}

const config = getConfig();

// --- Initialize search engine ---

const search = new SemanticSearch<Record<string, string>>({
  minSimilarity: config.minSimilarity,
  model: config.model,
  cacheDir: config.cacheDir,
});

try {
  await search.init();
} catch (err) {
  console.error(
    'Failed to load embedding model.',
    'An internet connection is required on first run to download the model (~25MB).',
    err
  );
  process.exit(1);
}

// Load persisted index
if (existsSync(config.storePath)) {
  try {
    const raw = await readFile(config.storePath, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      search.import(data);
    }
  } catch (err) {
    console.error(`Warning: Failed to load store from ${config.storePath}:`, err);
  }
}

async function persist() {
  const dir = dirname(config.storePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(config.storePath, JSON.stringify(search.export()));
}

// --- MCP Server ---

const server = new McpServer(
  {
    name: 'mcp-semantic-search',
    version: '0.1.0',
  },
  {
    capabilities: {
      logging: {},
    },
  }
);

// Tool: Semantic search
server.registerTool(
  'semantic_search',
  {
    title: 'Semantic Search',
    description:
      'Search indexed documents by meaning. Finds relevant content even when the wording differs from the query. Use this to recall past decisions, find related code patterns, or look up previously indexed context.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query'),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe('Maximum number of results to return'),
    }),
  },
  async ({ query, limit }) => {
    const results = await search.search(query, { limit });

    if (results.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No relevant results found.' }],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. [${(r.similarity * 100).toFixed(0)}% match] ${r.text}` +
          (r.metadata && Object.keys(r.metadata).length > 0
            ? `\n   metadata: ${JSON.stringify(r.metadata)}`
            : '')
      )
      .join('\n\n');

    return {
      content: [
        { type: 'text' as const, text: `Found ${results.length} result(s):\n\n${formatted}` },
      ],
    };
  }
);

// Tool: Index a document
server.registerTool(
  'semantic_index',
  {
    title: 'Index Document',
    description:
      'Add a document to the semantic search index for later recall. Use this to remember decisions, patterns, file summaries, conventions, debugging insights, or any context worth recalling later. Documents persist across sessions.',
    inputSchema: z.object({
      id: z
        .string()
        .describe(
          'Unique document ID. Use descriptive IDs like "adr-012", "auth-pattern", "deploy-steps"'
        ),
      text: z.string().describe('The text content to index and make searchable'),
      metadata: z
        .record(z.string())
        .optional()
        .describe('Optional key-value metadata (e.g. {"kind": "decision", "date": "2026-02-22"})'),
    }),
  },
  async ({ id, text, metadata }) => {
    await search.addDocument({ id, text, metadata });
    await persist();
    return {
      content: [
        {
          type: 'text' as const,
          text: `Indexed "${id}" (${search.size()} total documents in store)`,
        },
      ],
    };
  }
);

// Tool: Batch index multiple documents
server.registerTool(
  'semantic_index_batch',
  {
    title: 'Batch Index Documents',
    description:
      'Add multiple documents to the index at once. More efficient than indexing one at a time.',
    inputSchema: z.object({
      documents: z.array(
        z.object({
          id: z.string().describe('Unique document ID'),
          text: z.string().describe('Text content to index'),
          metadata: z
            .record(z.string())
            .optional()
            .describe('Optional key-value metadata'),
        })
      ).describe('Array of documents to index'),
    }),
  },
  async ({ documents }) => {
    await search.addDocuments(documents);
    await persist();
    return {
      content: [
        {
          type: 'text' as const,
          text: `Indexed ${documents.length} documents (${search.size()} total in store)`,
        },
      ],
    };
  }
);

// Tool: Remove a document
server.registerTool(
  'semantic_remove',
  {
    title: 'Remove Document',
    description: 'Remove a document from the semantic search index by its ID.',
    inputSchema: z.object({
      id: z.string().describe('Document ID to remove'),
    }),
  },
  async ({ id }) => {
    const removed = search.remove(id);
    if (removed) await persist();
    return {
      content: [
        {
          type: 'text' as const,
          text: removed
            ? `Removed "${id}" (${search.size()} documents remaining)`
            : `Document "${id}" not found in index`,
        },
      ],
    };
  }
);

// Tool: Get index stats
server.registerTool(
  'semantic_stats',
  {
    title: 'Index Stats',
    description:
      'Get information about the semantic search index: document count and storage location.',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: 'text' as const,
        text: [
          `Documents indexed: ${search.size()}`,
          `Store location: ${config.storePath}`,
          `Model: ${config.model}`,
          `Min similarity: ${config.minSimilarity}`,
        ].join('\n'),
      },
    ],
  })
);

// Tool: Clear all documents
server.registerTool(
  'semantic_clear',
  {
    title: 'Clear Index',
    description:
      'Remove ALL documents from the semantic search index. This is irreversible.',
    inputSchema: z.object({
      confirm: z
        .boolean()
        .describe('Must be true to confirm clearing all documents'),
    }),
  },
  async ({ confirm }) => {
    if (!confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Clear cancelled. Set confirm: true to clear all documents.',
          },
        ],
      };
    }

    const count = search.size();
    search.clear();
    await persist();
    return {
      content: [
        {
          type: 'text' as const,
          text: `Cleared ${count} documents from the index.`,
        },
      ],
    };
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
