import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readRepositoryFile(path) {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

test('the default test gate is deterministic and integration is explicit', async () => {
  const packageJson = JSON.parse(await readRepositoryFile('package.json'));

  assert.match(packageJson.scripts.test, /test:unit/);
  assert.doesNotMatch(packageJson.scripts.test, /test:integration|stdio-smoke/);
  assert.match(packageJson.scripts['test:integration'], /npm run build/);
  assert.match(packageJson.scripts['test:integration'], /stdio-smoke/);
});

test('the release workflow verifies all quality gates and cached integration coverage before publishing', async () => {
  const workflow = await readRepositoryFile('.github/workflows/npm-publish.yml');

  for (const command of ['format:check', 'lint', 'typecheck', 'build', 'test', 'test:integration']) {
    assert.match(workflow, new RegExp(`npm run ${command}`));
  }
  assert.match(workflow, /actions\/cache@v4/);
  assert.match(workflow, /\.cache\/mcp-semantic-search\/transformers/);
  assert.match(workflow, /MCP_SEMANTIC_TEST_CACHE_DIR/);
  assert.match(workflow, /npm publish --provenance --access public/);
});

test('format checking includes checked-in JSON configuration', async () => {
  const prettierIgnore = await readRepositoryFile('.prettierignore');

  assert.doesNotMatch(prettierIgnore, /^server\.json$/m);
  assert.doesNotMatch(prettierIgnore, /^tsconfig\.json$/m);
  assert.match(prettierIgnore, /^dist\/$/m);
  assert.match(prettierIgnore, /^node_modules\/$/m);
});
