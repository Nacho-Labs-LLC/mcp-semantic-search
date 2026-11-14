# Changelog

## 0.5.0

### Changed

- Adopt `@nacho-labs/nachos-embeddings` 0.6: use `SemanticSearch` (replaces the deprecated `EnhancedSemanticSearch`) and the new `deduplicate` option. Existing `MCP_SEMANTIC_DEDUPLICATE_*` variables behave as before: similarity > 0 becomes `{ similarity }`, exact only becomes `'normalized'`, both off becomes `'off'`.
- **Model cache now defaults to a per-user directory** (`$NACHOS_EMBEDDINGS_CACHE`, else XDG, else `~/.cache/nachos-embeddings`) instead of `.cache/transformers` in the working directory. If you have an existing cache, set `MCP_SEMANTIC_CACHE_DIR` to the old path to avoid a ~90MB re-download.
- Library logging is silent unless `MCP_SEMANTIC_VERBOSE` is set; temporal boost is now applied before the result limit.
- Startup failures no longer blame the network for non-network errors.

### Added

- Corrupt store handling: startup exits non-zero with an actionable message naming the file, without retrying. New `MCP_SEMANTIC_ON_CORRUPT_STORE` (`throw` | `quarantine`, default `throw`); `quarantine` renames the corrupt file aside and starts empty.

### Fixed

- Dependency updates (Dependabot #83-#88): MCP SDK 1.32.2, proxy-addr 2.0.8 (IP-spoofing security fix), zod 4.6.7, sharp 0.35.5 and adm-zip 0.6.1 overrides (clears all `npm audit` findings), eslint 10.14, @babel/core 8.0.10, @types/node 26.6.6, @aws-sdk/client-bedrock-runtime 3.1161.
- Server-reported version and `server.json` now match the package version.
