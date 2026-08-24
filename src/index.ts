#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EnhancedSemanticSearch } from '@nacho-labs/nachos-embeddings';
import type { EmbeddingProvider } from '@nacho-labs/nachos-embeddings';
import { resolve } from 'node:path';
import {
  DEFAULT_INDEX_ID,
  DOCUMENT_RESOURCE_TEMPLATE_URI,
  INDEX_MANIFEST_URI,
  INDEX_STATS_URI,
  REGISTERED_RESOURCE_URIS,
  buildDocumentResourceUri,
} from './product.js';

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

async function initWithRetry(maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (config.verbose) {
        console.error(`[Init] Attempt ${attempt}/${maxRetries}`);
      }
      await search.init();
      if (config.verbose) {
        console.error(`[Init] Loaded ${search.size()} documents`);
      }
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(
          '[Init] Failed after',
          maxRetries,
          'attempts. Internet required on first run (~25MB download).',
          err,
        );
        throw err;
      }
      console.error(`[Init] Retry in 2s...`, err);
      await new Promise((r) => setTimeout(r, 2000));
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

interface ResourceMetadata {
  kind?: string;
  tags?: string[];
  timestamp?: number;
  parentId?: string;
}

interface PersistedResourceDocument {
  id: string;
  text: string;
  metadata?: ResourceMetadata;
}

function getResourceDocuments(): PersistedResourceDocument[] {
  return search.export() as PersistedResourceDocument[];
}

function getResourceModelLabel(): string {
  return config.provider === 'bedrock' ? config.bedrockModel : config.model;
}

function getLatestDocumentTimestamp(documents: PersistedResourceDocument[]): string | undefined {
  const latest = documents.reduce<number | undefined>((current, document) => {
    const timestamp = document.metadata?.timestamp;
    return timestamp !== undefined && (current === undefined || timestamp > current) ? timestamp : current;
  }, undefined);

  return latest === undefined || Number.isNaN(latest) ? undefined : new Date(latest).toISOString();
}

function countMetadata(documents: PersistedResourceDocument[], key: 'kind' | 'tags'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const document of documents) {
    const values =
      key === 'tags' ? (document.metadata?.tags ?? []) : document.metadata?.kind ? [document.metadata.kind] : [];
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function renderJsonResource(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  };
}

function formatSearchResults(results: Array<{ similarity: number; text: string; metadata?: any }>): string {
  return results
    .map((r, i) => {
      const preview = r.text.substring(0, 200) + (r.text.length > 200 ? '...' : '');
      const metaStr = r.metadata && Object.keys(r.metadata).length > 0 ? `\n   📎 ${JSON.stringify(r.metadata)}` : '';
      return `${i + 1}. [${(r.similarity * 100).toFixed(0)}%] ${preview}${metaStr}`;
    })
    .join('\n\n');
}

function parseSemanticResourceUri(
  uri: string,
): { type: 'manifest' } | { type: 'stats' } | { type: 'document'; documentId: string } | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'semantic-search:' || parsed.hostname !== 'indexes') return undefined;
    const [indexId, resourceType, documentId, extra] = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (indexId !== DEFAULT_INDEX_ID || extra !== undefined) return undefined;
    if (resourceType === 'manifest' && documentId === undefined) return { type: 'manifest' };
    if (resourceType === 'stats' && documentId === undefined) return { type: 'stats' };
    if (resourceType === 'documents' && documentId) return { type: 'document', documentId };
  } catch {
    return undefined;
  }
  return undefined;
}

server.server.registerCapabilities({ resources: {} });

server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const documents = getResourceDocuments();
  const lastModified = getLatestDocumentTimestamp(documents);
  const annotations = {
    audience: ['user', 'assistant'] as const,
    ...(lastModified ? { lastModified } : {}),
  };
  return {
    resources: [
      {
        uri: INDEX_MANIFEST_URI,
        name: 'semantic_index_manifest',
        title: 'Semantic Index Manifest',
        description: 'Stable manifest for the active semantic-search index.',
        mimeType: 'application/json',
        annotations: { ...annotations, priority: 1 },
      },
      {
        uri: INDEX_STATS_URI,
        name: 'semantic_index_stats',
        title: 'Semantic Index Stats',
        description: 'Corpus stats and runtime counters for the active semantic-search index.',
        mimeType: 'application/json',
        annotations: { ...annotations, priority: 0.9 },
      },
    ],
  };
});

server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      name: 'semantic_document',
      title: 'Indexed Document',
      uriTemplate: DOCUMENT_RESOURCE_TEMPLATE_URI,
      description: 'Read a single indexed document by id from the active semantic-search index.',
      mimeType: 'application/json',
      annotations: { audience: ['user', 'assistant'], priority: 0.8 },
    },
  ],
}));

server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resource = parseSemanticResourceUri(request.params.uri);
  if (!resource) throw new McpError(ErrorCode.InvalidParams, `Resource ${request.params.uri} not found`);

  const documents = getResourceDocuments();
  if (resource.type === 'manifest') {
    return renderJsonResource(INDEX_MANIFEST_URI, {
      indexId: DEFAULT_INDEX_ID,
      resourceRoot: `semantic-search://indexes/${DEFAULT_INDEX_ID}`,
      storePath: config.storePath,
      provider: config.provider,
      model: getResourceModelLabel(),
      documentCount: documents.length,
      listedResources: [...REGISTERED_RESOURCE_URIS],
      resourceTemplates: [DOCUMENT_RESOURCE_TEMPLATE_URI],
      metricsStartedAt: new Date(metrics.startTime).toISOString(),
    });
  }
  if (resource.type === 'stats') {
    return renderJsonResource(INDEX_STATS_URI, {
      indexId: DEFAULT_INDEX_ID,
      storePath: config.storePath,
      provider: config.provider,
      model: getResourceModelLabel(),
      counts: {
        documents: documents.length,
        rootDocuments: documents.filter((document) => !document.metadata?.parentId).length,
        chunkDocuments: documents.filter((document) => document.metadata?.parentId).length,
      },
      metadata: { kinds: countMetadata(documents, 'kind'), tags: countMetadata(documents, 'tags') },
      usage: {
        searches: metrics.searches,
        documentsAdded: metrics.documentsAdded,
        documentsRemoved: metrics.documentsRemoved,
        errors: metrics.errors,
        uptimeSeconds: Math.floor((Date.now() - metrics.startTime) / 1000),
      },
    });
  }

  const document = documents.find((candidate) => candidate.id === resource.documentId);
  if (!document) throw new McpError(ErrorCode.InvalidParams, `Document ${resource.documentId} not found`);
  return renderJsonResource(buildDocumentResourceUri(document.id), {
    id: document.id,
    text: document.text,
    metadata: document.metadata ?? {},
  });
});

server.registerTool(
  'semantic_health',
  {
    title: 'Health Check',
    description: 'Server status, metrics, and configuration',
    inputSchema: z.object({}),
  },
  async () => {
    try {
      await search.search('test', { limit: 1 });

      const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
      const uptimeStr = formatUptime(uptime);

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
              `   Uptime: ${uptimeStr}`,
              '',
              '⚙️ Config:',
              `   Provider: ${config.provider}`,
              `   Model: ${config.provider === 'bedrock' ? config.bedrockModel : config.model}`,
              `   ${config.provider === 'bedrock' ? `Region: ${config.bedrockRegion}` : `Cache: ${config.cacheDir}`}`,
              `   Store: ${config.storePath}`,
              `   Min similarity: ${config.minSimilarity}`,
              `   Auto-chunk: ${config.autoChunk}`,
              `   Dedup: exact=${config.deduplicateExact}, fuzzy=${config.deduplicateSimilarity}`,
              `   Temporal boost: ${config.temporalBoost}`,
            ].join('\n'),
          },
        ],
      };
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
  },
);

server.registerTool(
  'semantic_search',
  {
    title: 'Semantic Search',
    description: 'Search by meaning with optional metadata filters',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      limit: z.number().int().min(1).max(100).optional().default(5).describe('Max results'),
      minSimilarity: z.number().min(0).max(1).optional().describe('Min score (0-1)'),
      kind: z.string().optional().describe('Filter by metadata.kind'),
      tags: z.array(z.string()).optional().describe('Filter by metadata.tags'),
      since: z.string().optional().describe('Filter by metadata.timestamp >= ISO date'),
    }),
  },
  async ({ query, limit, minSimilarity, kind, tags, since }) => {
    return opQueue.run(async () => {
      const startTime = Date.now();
      const parsedSince = since ? Date.parse(since) : undefined;
      const targetTags = tags ? new Set(tags) : undefined;

      const results = await search.search(query, {
        limit,
        ...(minSimilarity !== undefined && { minSimilarity }),
        filter: (meta: any) => {
          if (kind && meta?.kind !== kind) return false;
          if (targetTags && (!meta?.tags || !meta.tags.some((t: string) => targetTags.has(t)))) return false;
          if (parsedSince !== undefined && !isNaN(parsedSince) && meta?.timestamp && meta.timestamp < parsedSince)
            return false;
          return true;
        },
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

      const formatted = formatSearchResults(results);

      return {
        content: [
          {
            type: 'text' as const,
            text: `🔍 Found ${results.length} in ${elapsed}ms:\n\n${formatted}`,
          },
          ...results.map((result) => ({
            type: 'resource_link' as const,
            uri: buildDocumentResourceUri(result.id),
            name: result.id,
            mimeType: 'application/json',
            description: `Indexed document "${result.id}"`,
          })),
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

      await search.addDocuments(documents);

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
