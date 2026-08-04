#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EnhancedSemanticSearch } from '@nacho-labs/nachos-embeddings';
import type { EmbeddingProvider } from '@nacho-labs/nachos-embeddings';
import { resolve } from 'node:path';

const VERSION = '0.3.2';
const MAX_LENGTH = 1_000_000;
const MAX_ITEMS = 100;
const metadataValueSchema = z.union([
  z.string().max(MAX_LENGTH),
  z.number(),
  z.boolean(),
  z.array(z.string().max(MAX_LENGTH)).max(MAX_ITEMS),
]);

function getConfig() {
  const args = process.argv.slice(2);

  function getArg(name: string, fallback: string): string {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1]! : fallback;
  }

  function getString(name: string, fallback: string): string {
    const envName = `MCP_SEMANTIC_${name.toUpperCase().replace(/-/g, '_')}`;
    return process.env[envName] ?? getArg(name, fallback);
  }

  function getBool(name: string, fallback: boolean): boolean {
    const value = getString(name, fallback.toString());
    return value === 'true' || value === '1';
  }

  return {
    storePath: resolve(getString('store', '.semantic-store.json')),
    minSimilarity: parseFloat(getString('similarity', '0.4')),
    model: getString('model', 'Xenova/all-MiniLM-L6-v2'),
    cacheDir: getString('cache-dir', '.cache/transformers'),
    autoChunk: getBool('auto-chunk', true),
    deduplicateExact: getBool('deduplicate-exact', true),
    deduplicateSimilarity: parseFloat(getString('deduplicate-similarity', '0.95')),
    temporalBoost: getBool('temporal-boost', true),
    verbose: getBool('verbose', false),

    // Bedrock provider settings
    provider: getString('provider', 'transformers') as 'transformers' | 'bedrock',
    bedrockRegion: getString('bedrock-region', 'us-east-1'),
    bedrockModel: getString('bedrock-model', 'amazon.titan-embed-text-v2:0'),
    bedrockProfile: getString('bedrock-profile', ''),
    bedrockDimensions: parseInt(getString('bedrock-dimensions', '1024'), 10),
  };
}

async function createProvider(config: ReturnType<typeof getConfig>): Promise<EmbeddingProvider | undefined> {
  if (config.provider !== 'bedrock') {
    return undefined; // Use default Transformers.js
  }

  const { BedrockProvider } = await import('@nacho-labs/nachos-embeddings/bedrock');

  return new BedrockProvider({
    region: config.bedrockRegion,
    modelId: config.bedrockModel,
    ...(config.bedrockProfile ? { credentials: { strategy: 'profile' as const, profile: config.bedrockProfile } } : {}),
    modelOptions: { dimensions: config.bedrockDimensions },
    progressLogging: config.verbose,
  });
}

const config = getConfig();

interface Metrics {
  searches: number;
  documentsAdded: number;
  documentsRemoved: number;
  errors: number;
  startTime: number;
}

const metrics: Metrics = {
  searches: 0,
  documentsAdded: 0,
  documentsRemoved: 0,
  errors: 0,
  startTime: Date.now(),
};

const provider = await createProvider(config);

const search = new EnhancedSemanticSearch({
  ...(provider ? { provider } : {}),
  minSimilarity: config.minSimilarity,
  model: config.model,
  cacheDir: config.cacheDir,
  autoSave: true,
  storePath: config.storePath,
  autoChunk: config.autoChunk,
  deduplicateExact: config.deduplicateExact,
  deduplicateSimilarity: config.deduplicateSimilarity,
  temporalBoost: config.temporalBoost,
  verbose: config.verbose,
});

async function initializeSearch(attempt: number, maxRetries: number): Promise<void> {
  if (config.verbose) {
    console.error(`[Init] Attempt ${attempt}/${maxRetries}`);
  }
  await search.init();
  if (config.verbose) {
    console.error(`[Init] Loaded ${search.size()} documents`);
  }
}

async function handleInitializationFailure(attempt: number, maxRetries: number, err: unknown): Promise<void> {
  if (attempt === maxRetries) {
    console.error('[Init] Failed after', maxRetries, 'attempts. Internet required on first run (~25MB download).', err);
    throw err;
  }
  console.error(`[Init] Retry in 2s...`, err);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function initWithRetry(maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await initializeSearch(attempt, maxRetries);
      return;
    } catch (err) {
      await handleInitializationFailure(attempt, maxRetries, err);
    }
  }
}

try {
  await initWithRetry();
} catch {
  process.exit(1);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function matchesKind(meta: any, kind: string | undefined): boolean {
  return !kind || meta?.kind === kind;
}

function matchesTags(meta: any, tags: string[] | undefined): boolean {
  return !tags || Boolean(meta?.tags && tags.some((tag) => meta.tags?.includes(tag)));
}

function hasValidSince(parsedSince: number | undefined): parsedSince is number {
  return parsedSince !== undefined && !isNaN(parsedSince);
}

function isBeforeSince(meta: any, parsedSince: number): boolean {
  return Boolean(meta?.timestamp && meta.timestamp < parsedSince);
}

function matchesSince(meta: any, parsedSince: number | undefined): boolean {
  return !hasValidSince(parsedSince) || !isBeforeSince(meta, parsedSince);
}

function matchesMetadata(
  meta: any,
  kind: string | undefined,
  tags: string[] | undefined,
  parsedSince: number | undefined,
) {
  return matchesKind(meta, kind) && matchesTags(meta, tags) && matchesSince(meta, parsedSince);
}

class OpQueue {
  private queue = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolve: ((val: void | PromiseLike<void>) => void) | undefined;

    this.queue = new Promise<void>((res) => {
      resolve = res;
    });

    try {
      await prev.catch(() => {});
      const result = await fn();
      return result;
    } catch (err) {
      metrics.errors++;
      throw err;
    } finally {
      resolve!();
    }
  }
}

const opQueue = new OpQueue();

const server = new McpServer(
  { name: 'mcp-semantic-search-enhanced', version: VERSION },
  { capabilities: { logging: {} } },
);

function buildHealthResponse() {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const model = config.provider === 'bedrock' ? config.bedrockModel : config.model;
  const providerSetting =
    config.provider === 'bedrock' ? `Region: ${config.bedrockRegion}` : `Cache: ${config.cacheDir}`;

  return {
    content: [
      {
        type: 'text' as const,
        text: [
          '✅ Healthy',
          '',
          '📊 Metrics:',
          `   Documents: ${search.size()}`,
          `   Searches: ${metrics.searches}`,
          `   Added: ${metrics.documentsAdded}`,
          `   Removed: ${metrics.documentsRemoved}`,
          `   Errors: ${metrics.errors}`,
          `   Uptime: ${formatUptime(uptime)}`,
          '',
          '⚙️ Config:',
          `   Provider: ${config.provider}`,
          `   Model: ${model}`,
          `   ${providerSetting}`,
          `   Store: ${config.storePath}`,
          `   Min similarity: ${config.minSimilarity}`,
          `   Auto-chunk: ${config.autoChunk}`,
          `   Dedup: exact=${config.deduplicateExact}, fuzzy=${config.deduplicateSimilarity}`,
          `   Temporal boost: ${config.temporalBoost}`,
        ].join('\n'),
      },
    ],
  };
}

async function getHealthResponse() {
  try {
    await search.search('test', { limit: 1 });
    return buildHealthResponse();
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `❌ Unhealthy: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

server.registerTool(
  'semantic_health',
  {
    title: 'Health Check',
    description: 'Server status, metrics, and configuration',
    inputSchema: z.object({}),
  },
  getHealthResponse,
);

server.registerTool(
  'semantic_search',
  {
    title: 'Semantic Search',
    description: 'Search by meaning with optional metadata filters',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(5).describe('Max results'),
      minSimilarity: z.number().optional().describe('Min score (0-1)'),
      kind: z.string().optional().describe('Filter by metadata.kind'),
      tags: z.array(z.string()).optional().describe('Filter by metadata.tags'),
      since: z.string().optional().describe('Filter by metadata.timestamp >= ISO date'),
    }),
  },
  async ({ query, limit, minSimilarity, kind, tags, since }) => {
    return opQueue.run(async () => {
      const startTime = Date.now();
      const parsedSince = since ? Date.parse(since) : undefined;

      const results = await search.search(query, {
        limit,
        ...(minSimilarity !== undefined && { minSimilarity }),
        filter: (meta: any) => matchesMetadata(meta, kind, tags, parsedSince),
      });

      metrics.searches++;
      const elapsed = Date.now() - startTime;

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `🔍 No results for "${query}" (${elapsed}ms)`,
            },
          ],
        };
      }

      const formatted = results
        .map((r, i) => {
          const preview = r.text.substring(0, 200) + (r.text.length > 200 ? '...' : '');
          const metaStr =
            r.metadata && Object.keys(r.metadata).length > 0 ? `\n   📎 ${JSON.stringify(r.metadata)}` : '';
          return `${i + 1}. [${(r.similarity * 100).toFixed(0)}%] ${preview}${metaStr}`;
        })
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `🔍 Found ${results.length} in ${elapsed}ms:\n\n${formatted}`,
          },
        ],
      };
    });
  },
);

server.registerTool(
  'semantic_index',
  {
    title: 'Index Document',
    description: 'Add document to search index (auto-chunks, deduplicates, persists)',
    inputSchema: z.object({
      id: z.string().describe('Unique ID (e.g., "auth-pattern", "adr-012")'),
      text: z.string().describe('Content to index'),
      metadata: z.record(z.string(), metadataValueSchema).optional().describe('Optional metadata'),
    }),
  },
  async ({ id, text, metadata }) => {
    return opQueue.run(async () => {
      const startTime = Date.now();

      await search.addDocument({ id, text, metadata });

      metrics.documentsAdded++;
      const elapsed = Date.now() - startTime;

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `✅ Indexed "${id}" (${elapsed}ms)`,
              `📊 ${search.size()} documents total`,
              `💾 Saved to ${config.storePath}`,
              `🔍 Test: semantic_search("${id}")`,
            ].join('\n'),
          },
        ],
      };
    });
  },
);

server.registerTool(
  'semantic_index_batch',
  {
    title: 'Batch Index',
    description: 'Add multiple documents at once',
    inputSchema: z.object({
      documents: z
        .array(
          z.object({
            id: z.string().max(MAX_LENGTH),
            text: z.string().max(MAX_LENGTH),
            metadata: z.record(z.string(), metadataValueSchema).optional(),
          }),
        )
        .max(MAX_ITEMS),
    }),
  },
  async ({ documents }) => {
    return opQueue.run(async () => {
      const startTime = Date.now();

      await search.addDocuments(documents.map((d) => ({ ...d, metadata: d.metadata })));

      metrics.documentsAdded += documents.length;
      const elapsed = Date.now() - startTime;

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `✅ Indexed ${documents.length} documents (${elapsed}ms)`,
              `   ${Math.round(documents.length / (elapsed / 1000))}/sec`,
              `📊 ${search.size()} documents total`,
            ].join('\n'),
          },
        ],
      };
    });
  },
);

server.registerTool(
  'semantic_remove',
  {
    title: 'Remove Document',
    description: 'Delete by ID',
    inputSchema: z.object({
      id: z.string(),
    }),
  },
  async ({ id }) => {
    return opQueue.run(async () => {
      const removed = await search.remove(id);

      if (removed) {
        metrics.documentsRemoved++;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: removed ? `✅ Removed "${id}"\n📊 ${search.size()} remaining` : `⚠️ "${id}" not found`,
          },
        ],
      };
    });
  },
);

server.registerTool(
  'semantic_stats',
  {
    title: 'Index Stats',
    description: 'Detailed index information',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: 'text' as const,
        text: [
          '📊 Index Stats',
          '',
          `Documents: ${search.size()}`,
          `Provider: ${config.provider}`,
          `Model: ${config.provider === 'bedrock' ? config.bedrockModel : config.model}`,
          `Store: ${config.storePath}`,
          `Min similarity: ${config.minSimilarity}`,
          '',
          'Features:',
          `   Auto-chunk: ${config.autoChunk}`,
          `   Dedup (exact): ${config.deduplicateExact}`,
          `   Dedup (fuzzy): ${config.deduplicateSimilarity > 0 ? config.deduplicateSimilarity : 'off'}`,
          `   Temporal boost: ${config.temporalBoost}`,
          '',
          'Usage:',
          `   Searches: ${metrics.searches}`,
          `   Added: ${metrics.documentsAdded}`,
          `   Removed: ${metrics.documentsRemoved}`,
          `   Errors: ${metrics.errors}`,
        ].join('\n'),
      },
    ],
  }),
);

server.registerTool(
  'semantic_clear',
  {
    title: 'Clear Index',
    description: 'Remove all documents (irreversible)',
    inputSchema: z.object({
      confirm: z.boolean().describe('Must be true'),
    }),
  },
  async ({ confirm }) => {
    if (!confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text: '⚠️ Cancelled. Set confirm: true to proceed',
          },
        ],
      };
    }

    return opQueue.run(async () => {
      const count = search.size();
      await search.clear();

      return {
        content: [
          {
            type: 'text' as const,
            text: `✅ Cleared ${count} documents\n💾 Saved to ${config.storePath}`,
          },
        ],
      };
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

if (config.verbose) {
  console.error('[Server] Ready');
}
