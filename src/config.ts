export type DeduplicateOption = 'off' | 'exact' | 'normalized' | { similarity: number };
export type CorruptStoreMode = 'throw' | 'quarantine';

/**
 * Map the legacy exact/similarity settings onto nachos-embeddings' `deduplicate` option.
 * similarity > 0 wins; otherwise exact on means 'normalized'; both off means 'off'.
 */
export function resolveDeduplicate(exact: boolean, similarity: number): DeduplicateOption {
  if (Number.isFinite(similarity) && similarity > 0) return { similarity };
  return exact ? 'normalized' : 'off';
}

export function parseCorruptStoreMode(value: string): CorruptStoreMode {
  if (value === 'throw' || value === 'quarantine') return value;
  throw new Error(`Invalid MCP_SEMANTIC_ON_CORRUPT_STORE "${value}". Expected "throw" or "quarantine".`);
}

export function getConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  function getArg(name: string, fallback: string): string {
    const idx = argv.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1]! : fallback;
  }

  function getString(name: string, fallback: string): string {
    const envName = `MCP_SEMANTIC_${name.toUpperCase().replace(/-/g, '_')}`;
    return env[envName] ?? getArg(name, fallback);
  }

  function getBool(name: string, fallback: boolean): boolean {
    const value = getString(name, fallback.toString());
    return value === 'true' || value === '1';
  }

  const deduplicateExact = getBool('deduplicate-exact', true);
  const deduplicateSimilarity = parseFloat(getString('deduplicate-similarity', '0.95'));
  // Empty means "use the library's per-user cache".
  const cacheDir = getString('cache-dir', '');

  return {
    storePath: getString('store', '.semantic-store.json'),
    minSimilarity: parseFloat(getString('similarity', '0.4')),
    model: getString('model', 'Xenova/all-MiniLM-L6-v2'),
    cacheDir: cacheDir === '' ? undefined : cacheDir,
    autoChunk: getBool('auto-chunk', true),
    deduplicateExact,
    deduplicateSimilarity,
    deduplicate: resolveDeduplicate(deduplicateExact, deduplicateSimilarity),
    onCorruptStore: parseCorruptStoreMode(getString('on-corrupt-store', 'throw')),
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

export type Config = ReturnType<typeof getConfig>;
