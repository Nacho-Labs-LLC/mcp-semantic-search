# @nacho-labs/mcp-semantic-search

MCP server that gives AI coding tools persistent semantic memory. Index
decisions, patterns, and project context — recall them by meaning, not keywords.

Powered by [@nacho-labs/nachos-embeddings](https://github.com/nacho-labs-llc/nachos-embeddings).
Runs entirely locally with [Transformers.js](https://huggingface.co/docs/transformers.js) —
no API keys, no cloud, no costs.

## Prerequisites

- **Node.js 18+**
- **Internet on first run** to download the embedding model (~25MB, cached permanently)

## Quick start

### Claude Code

```bash
claude mcp add --transport stdio semantic-search -- npx @nacho-labs/mcp-semantic-search
```

### Cursor / VS Code / any MCP client

Add to your MCP config (`.mcp.json`, `mcp.json`, or client-specific config):

```json
{
  "mcpServers": {
    "semantic-search": {
      "type": "stdio",
      "command": "npx",
      "args": ["@nacho-labs/mcp-semantic-search"]
    }
  }
}
```

That's it. Your AI tool now has six semantic memory tools.

## Tools

| Tool | Description |
| ---- | ----------- |
| `semantic_search` | Search indexed documents by meaning |
| `semantic_index` | Add a document to the index |
| `semantic_index_batch` | Add multiple documents at once |
| `semantic_remove` | Remove a document by ID |
| `semantic_stats` | Get index size, store location, and config |
| `semantic_clear` | Remove all documents (requires confirmation) |

## What it does

```text
You ask Claude: "How do we handle rate limiting?"
                 |
Claude calls:    semantic_search("rate limiting")
                 |
Server embeds:   query -> 384-dimension vector
                 |
Cosine search:   against all indexed vectors
                 |
Returns:         "We throttle API requests using sliding windows..."
                 (matched by meaning, not keywords)
```

The embedding model understands meaning:

| Query | Finds |
| ----- | ----- |
| "rate limiting" | "We throttle API requests using sliding windows" |
| "how to deploy" | "Production runs via docker compose up with..." |
| "error handling" | "We use Result types instead of try/catch for..." |

## What to index

High-value content for project memory:

**Architecture decisions** — "We chose PostgreSQL over DynamoDB because we need
complex joins for the reporting module."

**Code patterns** — "Authentication middleware is in src/middleware/auth.ts.
Uses JWT with RS256, tokens expire after 1 hour, refresh tokens after 30 days."

**Conventions** — "All API endpoints return { data, error, meta } shape.
Errors use RFC 7807 problem details format."

**Debugging insights** — "If the worker queue backs up, check Redis memory.
The default maxmemory-policy is noeviction which causes write failures."

## Configuration

### CLI arguments

```bash
npx @nacho-labs/mcp-semantic-search \
  --store /path/to/store.json \
  --similarity 0.5 \
  --model Xenova/all-mpnet-base-v2 \
  --cache-dir /tmp/models
```

### Environment variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `MCP_SEMANTIC_STORE` | Path to persistence file | `.semantic-store.json` |
| `MCP_SEMANTIC_SIMILARITY` | Min similarity threshold (0-1) | `0.6` |
| `MCP_SEMANTIC_MODEL` | Embedding model | `Xenova/all-MiniLM-L6-v2` |
| `MCP_SEMANTIC_CACHE_DIR` | Model cache directory | `.cache/transformers` |

### With environment variables in MCP config

```json
{
  "mcpServers": {
    "semantic-search": {
      "type": "stdio",
      "command": "npx",
      "args": ["@nacho-labs/mcp-semantic-search"],
      "env": {
        "MCP_SEMANTIC_STORE": "/home/user/.semantic-memory/project.json",
        "MCP_SEMANTIC_SIMILARITY": "0.5"
      }
    }
  }
}
```

## Performance

| Operation | Time |
| --------- | ---- |
| Server startup (model cached) | ~500ms |
| Server startup (first run) | ~2-5s |
| Index a document | ~10-50ms |
| Search 1000 documents | ~5-10ms |

**Memory:** ~100MB for model + ~1.5KB per document.

The in-memory store works well up to ~10K documents. Beyond that, consider a
dedicated vector database.

## Persistence

The index is saved to disk automatically after every write operation (index,
remove, clear). On startup, the server loads the existing store if present.

Default location: `.semantic-store.json` in the working directory.

## How it's built

This MCP server is a thin wrapper around two packages:

- **[@nacho-labs/nachos-embeddings](https://www.npmjs.com/package/@nacho-labs/nachos-embeddings)** — Local vector embeddings and semantic search
- **[@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)** — Official MCP TypeScript SDK

The embeddings package can also be used directly in your own code. See its
[README](https://github.com/nacho-labs-llc/nachos-embeddings) for the
standalone API.

## Development

```bash
git clone https://github.com/nacho-labs-llc/mcp-semantic-search.git
cd mcp-semantic-search
npm install
npm run build
npm start
```

## License

MIT
