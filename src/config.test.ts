import test from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { getConfig } from './config.js';

test('getConfig', async (t) => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  t.afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
  });

  await t.test('default values', () => {
    process.env = {};
    process.argv = ['node', 'index.js'];

    const config = getConfig();

    assert.strictEqual(config.storePath, resolve('.semantic-store.json'));
    assert.strictEqual(config.minSimilarity, 0.4);
    assert.strictEqual(config.model, 'Xenova/all-MiniLM-L6-v2');
    assert.strictEqual(config.cacheDir, '.cache/transformers');
    assert.strictEqual(config.autoChunk, true);
    assert.strictEqual(config.deduplicateExact, true);
    assert.strictEqual(config.deduplicateSimilarity, 0.95);
    assert.strictEqual(config.temporalBoost, true);
    assert.strictEqual(config.verbose, false);
    assert.strictEqual(config.provider, 'transformers');
    assert.strictEqual(config.bedrockRegion, 'us-east-1');
    assert.strictEqual(config.bedrockModel, 'amazon.titan-embed-text-v2:0');
    assert.strictEqual(config.bedrockProfile, '');
    assert.strictEqual(config.bedrockDimensions, 1024);
  });

  await t.test('override with CLI arguments', () => {
    process.env = {};
    process.argv = [
      'node',
      'index.js',
      '--store',
      'custom-store.json',
      '--similarity',
      '0.8',
      '--auto-chunk',
      'false',
      '--provider',
      'bedrock',
    ];

    const config = getConfig();

    assert.strictEqual(config.storePath, resolve('custom-store.json'));
    assert.strictEqual(config.minSimilarity, 0.8);
    assert.strictEqual(config.autoChunk, false);
    assert.strictEqual(config.provider, 'bedrock');
  });

  await t.test('override with Environment variables', () => {
    process.env = {
      MCP_SEMANTIC_STORE: 'env-store.json',
      MCP_SEMANTIC_SIMILARITY: '0.9',
      'MCP_SEMANTIC_AUTO-CHUNK': 'false', // note the hyphen because name.toUpperCase() doesn't replace - with _
      MCP_SEMANTIC_PROVIDER: 'bedrock',
    };
    process.argv = ['node', 'index.js'];

    const config = getConfig();

    assert.strictEqual(config.storePath, resolve('env-store.json'));
    assert.strictEqual(config.minSimilarity, 0.9);
    assert.strictEqual(config.autoChunk, false);
    assert.strictEqual(config.provider, 'bedrock');
  });

  await t.test('Environment variables precedence over CLI arguments', () => {
    process.env = {
      MCP_SEMANTIC_STORE: 'env-store.json',
    };
    process.argv = ['node', 'index.js', '--store', 'cli-store.json'];

    const config = getConfig();

    assert.strictEqual(config.storePath, resolve('env-store.json'));
  });

  await t.test('boolean parsing with 1 and 0 for true/false', () => {
    process.env = {};
    process.argv = ['node', 'index.js', '--verbose', '1', '--auto-chunk', '0'];

    const config = getConfig();

    assert.strictEqual(config.verbose, true);
    assert.strictEqual(config.autoChunk, false); // because fallback is true, but we passed 0, so it's not 'true' or '1'
  });
});
