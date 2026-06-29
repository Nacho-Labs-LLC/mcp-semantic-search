import { resolve } from 'node:path';

export function getConfig() {
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
    minSimilarity: parseFloat(process.env.MCP_SEMANTIC_SIMILARITY ?? getArg('similarity', '0.4')),
    model: process.env.MCP_SEMANTIC_MODEL ?? getArg('model', 'Xenova/all-MiniLM-L6-v2'),
    cacheDir: process.env.MCP_SEMANTIC_CACHE_DIR ?? getArg('cache-dir', '.cache/transformers'),
    autoChunk: getBool('auto-chunk', true),
    deduplicateExact: getBool('deduplicate-exact', true),
    deduplicateSimilarity: parseFloat(process.env.MCP_SEMANTIC_DEDUPLICATE_SIMILARITY ?? getArg('deduplicate-similarity', '0.95')),
    temporalBoost: getBool('temporal-boost', true),
    verbose: getBool('verbose', false),

    // Bedrock provider settings
    provider: (process.env.MCP_SEMANTIC_PROVIDER ?? getArg('provider', 'transformers')) as 'transformers' | 'bedrock',
    bedrockRegion: process.env.MCP_SEMANTIC_BEDROCK_REGION ?? getArg('bedrock-region', 'us-east-1'),
    bedrockModel: process.env.MCP_SEMANTIC_BEDROCK_MODEL ?? getArg('bedrock-model', 'amazon.titan-embed-text-v2:0'),
    bedrockProfile: process.env.MCP_SEMANTIC_BEDROCK_PROFILE ?? getArg('bedrock-profile', ''),
    bedrockDimensions: parseInt(process.env.MCP_SEMANTIC_BEDROCK_DIMENSIONS ?? getArg('bedrock-dimensions', '1024'), 10),
  };
}
