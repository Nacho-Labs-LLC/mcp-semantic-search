#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EnhancedSemanticSearch } from '@nacho-labs/nachos-embeddings';
import { resolve } from 'node:path';

function getConfig() {
  const args = process.argv.slice(2);

  function getArg(name: string, fallback: string): string {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1]! : fallback;
  }

  function getBool(name: string, fallback: boolean): boolean {
    const value = process.env[`MCP_SEMANTIC_${name.toUpperCase()}`] ?? getArg(name, fallback.toString());
    return value === 'true' || value === '1';
  }

  return {
    storePath: resolve(process.env.MCP_SEMANTIC_STORE ?? getArg('store', '.semantic-store.json')),
    minSimilarity: parseFloat(process.env.MCP_SEMANTIC_SIMILARITY ?? getArg('similarity', '0.6')),
    model: process.env.MCP_SEMANTIC_MODEL ?? getArg('model', 'Xenova/all-MiniLM-L6-v2'),
    cacheDir: process.env.MCP_SEMANTIC_CACHE_DIR ?? getArg('cache-dir', '.cache/transformers'),
    autoChunk: getBool('auto-chunk', true),
    deduplicateExact: getBool('deduplicate-exact', true),
    deduplicateSimilarity: parseFloat(process.env.MCP_SEMANTIC_DEDUPLICATE_SIMILARITY ?? getArg('deduplicate-similarity', '0.95')),
    temporalBoost: getBool('temporal-boost', true),
    verbose: getBool('verbose', false),
  };
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

const search = new EnhancedSemanticSearch({
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
        console.error('[Init] Failed after', maxRetries, 'attempts. Internet required on first run (~25MB download).', err);
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

class OpQueue {
  private queue = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let resolve: ((val: T | PromiseLike<T>) => void) | undefined;
    let reject: ((err: unknown) => void) | undefined;

    this.queue = new Promise<void>((res, rej) => {
      resolve = res as any;
      reject = rej;
    });

    try {
      await prev;
      const result = await fn();
      resolve!(result);
      return result;
    } catch (err) {
      reject!(err);
      metrics.errors++;
      throw err;
    }
  }
}

const opQueue = new OpQueue();

const server = new McpServer(
  { name: 'mcp-semantic-search-enhanced', version: '0.2.0' },
  { capabilities: { logging: {} } }
);

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
      const uptimeStr = uptime < 60 ? `${uptime}s` : uptime < 3600 ? `${Math.floor(uptime / 60)}m` : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

      return {
        content: [{
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
            `   Model: ${config.model}`,
            `   Store: ${config.storePath}`,
            `   Min similarity: ${config.minSimilarity}`,
            `   Auto-chunk: ${config.autoChunk}`,
            `   Dedup: exact=${config.deduplicateExact}, fuzzy=${config.deduplicateSimilarity}`,
            `   Temporal boost: ${config.temporalBoost}`,
          ].join('\n'),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `❌ Unhealthy: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
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

      const results = await search.search(query, {
        limit,
        ...(minSimilarity !== undefined && { minSimilarity }),
        filter: (meta) => {
          if (kind && meta?.kind !== kind) return false;
          if (tags && (!meta?.tags || !tags.some((t) => meta.tags?.includes(t)))) return false;
          if (since && meta?.timestamp && meta.timestamp < Date.parse(since)) return false;
          return true;
        },
      });

      metrics.searches++;
      const elapsed = Date.now() - startTime;

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `🔍 No results for "${query}" (${elapsed}ms)`,
          }],
        };
      }

      const formatted = results
        .map((r, i) => {
          const preview = r.text.substring(0, 200) + (r.text.length > 200 ? '...' : '');
          const metaStr = r.metadata && Object.keys(r.metadata).length > 0 ? `\n   📎 ${JSON.stringify(r.metadata)}` : '';
          return `${i + 1}. [${(r.similarity * 100).toFixed(0)}%] ${preview}${metaStr}`;
        })
        .join('\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `🔍 Found ${results.length} in ${elapsed}ms:\n\n${formatted}`,
        }],
      };
    });
  }
);

server.registerTool(
  'semantic_index',
  {
    title: 'Index Document',
    description: 'Add document to search index (auto-chunks, deduplicates, persists)',
    inputSchema: z.object({
      id: z.string().describe('Unique ID (e.g., "auth-pattern", "adr-012")'),
      text: z.string().describe('Content to index'),
      metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional().describe('Optional metadata'),
    }),
  },
  async ({ id, text, metadata }) => {
    return opQueue.run(async () => {
      const startTime = Date.now();

      await search.addDocument({ id, text, metadata: metadata as any });

      metrics.documentsAdded++;
      const elapsed = Date.now() - startTime;

      return {
        content: [{
          type: 'text' as const,
          text: [
            `✅ Indexed "${id}" (${elapsed}ms)`,
            `📊 ${search.size()} documents total`,
            `💾 Saved to ${config.storePath}`,
            `🔍 Test: semantic_search("${id}")`,
          ].join('\n'),
        }],
      };
    });
  }
);

server.registerTool(
  'semantic_index_batch',
  {
    title: 'Batch Index',
    description: 'Add multiple documents at once',
    inputSchema: z.object({
      documents: z.array(z.object({
        id: z.string(),
        text: z.string(),
        metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
      })),
    }),
  },
  async ({ documents }) => {
    return opQueue.run(async () => {
      const startTime = Date.now();

      await search.addDocuments(documents.map((d) => ({ ...d, metadata: d.metadata as any })));

      metrics.documentsAdded += documents.length;
      const elapsed = Date.now() - startTime;

      return {
        content: [{
          type: 'text' as const,
          text: [
            `✅ Indexed ${documents.length} documents (${elapsed}ms)`,
            `   ${Math.round(documents.length / (elapsed / 1000))}/sec`,
            `📊 ${search.size()} documents total`,
          ].join('\n'),
        }],
      };
    });
  }
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
      const removed = search.remove(id);

      if (removed) {
        metrics.documentsRemoved++;
      }

      return {
        content: [{
          type: 'text' as const,
          text: removed
            ? `✅ Removed "${id}"\n📊 ${search.size()} remaining`
            : `⚠️ "${id}" not found`,
        }],
      };
    });
  }
);

server.registerTool(
  'semantic_stats',
  {
    title: 'Index Stats',
    description: 'Detailed index information',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{
      type: 'text' as const,
      text: [
        '📊 Index Stats',
        '',
        `Documents: ${search.size()}`,
        `Store: ${config.storePath}`,
        `Model: ${config.model}`,
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
    }],
  })
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
        content: [{
          type: 'text' as const,
          text: '⚠️ Cancelled. Set confirm: true to proceed',
        }],
      };
    }

    return opQueue.run(async () => {
      const count = search.size();
      search.clear();

      return {
        content: [{
          type: 'text' as const,
          text: `✅ Cleared ${count} documents\n💾 Saved to ${config.storePath}`,
        }],
      };
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

if (config.verbose) {
  console.error('[Server] Ready');
}
