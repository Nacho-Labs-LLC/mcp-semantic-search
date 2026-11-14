import { StoreCorruptError } from '@nacho-labs/nachos-embeddings';

export function isStoreCorruptError(err: unknown): err is Error & { path?: string } {
  return err instanceof StoreCorruptError || (err instanceof Error && err.name === 'StoreCorruptError');
}

export interface InitDeps {
  search: { init(): Promise<void>; size(): number };
  storePath: string;
  verbose: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  log?: (...args: unknown[]) => void;
}

export function corruptStoreMessage(err: Error & { path?: string }, storePath: string): string {
  const file = err.path ?? storePath;
  return [
    `[Init] The semantic store file is corrupt and could not be loaded: ${file}`,
    `       ${err.message}`,
    '       To fix it, do one of:',
    '         - repair the file by hand, or delete it (the index will start empty)',
    '         - set MCP_SEMANTIC_ON_CORRUPT_STORE=quarantine to rename the corrupt file aside and start empty',
  ].join('\n');
}

/**
 * Initialise the search index. Corrupt stores are never retried. Throws on final failure
 * after logging an actionable message.
 */
export async function initWithRetry(deps: InitDeps): Promise<void> {
  const { search, storePath, verbose, maxRetries = 3, retryDelayMs = 2000, log = console.error } = deps;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (verbose) log(`[Init] Attempt ${attempt}/${maxRetries}`);
      await search.init();
      if (verbose) log(`[Init] Loaded ${search.size()} documents`);
      return;
    } catch (err) {
      if (isStoreCorruptError(err)) {
        log(corruptStoreMessage(err, storePath));
        throw err;
      }
      if (attempt === maxRetries) {
        log(
          `[Init] Failed after ${maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}\n` +
            '       Check the store path, model name, and provider settings. If this is the first run, ' +
            'the model download (~25MB) needs network access, which is one possible cause.',
          err,
        );
        throw err;
      }
      log('[Init] Retry in 2s...', err);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}
