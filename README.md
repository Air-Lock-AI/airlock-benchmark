# Airlock Meta-Tools Benchmark

Benchmark token savings of [Airlock's](https://www.air-lock.ai) **meta-tools approach** vs traditional **full tool expansion** for MCP (Model Context Protocol) servers.

## Background

When exposing APIs to AI agents via MCP, there are two approaches:

### Full Expansion (Traditional)
Every API endpoint becomes an individual MCP tool. For an organization with 10 connected APIs averaging 30 endpoints each, the AI receives **300 tool definitions** in every message.

### Meta-Tools (Airlock's Approach)
Only **4 tools** are exposed regardless of how many APIs are connected:

| Tool | Purpose |
|------|---------|
| `list_services` | List connected services with tool counts |
| `search_tools` | Find tools by keyword |
| `describe_tools` | Get full schema for specific tools |
| `execute_tool` | Run any tool via `service-slug/tool-name` |

## Quick Start

```bash
# Clone the repository
git clone https://github.com/Air-Lock-AI/airlock-benchmark.git
cd airlock-benchmark

# Install dependencies
npm install

# Run the benchmark
npm run benchmark
```

## Sample Output

```
📦 Meta-Tools (4 tools):
--------------------------------------------------
  list_services       :     60 tokens
  search_tools        :    123 tokens
  describe_tools      :    112 tokens
  execute_tool        :    131 tokens
--------------------------------------------------
  TOTAL               :    426 tokens

📊 Benchmark Results:
----------------------------------------------------------------------------------------------------
| Scenario                              | APIs | Tools | Meta    | Full      | Saved     | %     |
|---------------------------------------|------|-------|---------|-----------|-----------|-------|
| Single API (Linear)                   | 1    | 9     | 426     | 1,066     | 640       | 60.0% |
| Single API (GitHub)                   | 1    | 18    | 426     | 2,847     | 2,421     | 85.0% |
| Three APIs (typical org)              | 3    | 33    | 426     | 4,746     | 4,320     | 91.0% |
| Large org (10 APIs)                   | 10   | 250+  | 426     | 35,000+   | 34,500+   | 98.8% |
```

## Output Formats

```bash
# Terminal output (default)
npm run benchmark

# JSON (for programmatic use)
npm run benchmark:json

# Markdown (for documentation)
npm run benchmark:markdown
```

## Live Benchmark (Against Your Airlock Instance)

Measure actual token usage against your real Airlock organization:

```bash
# Interactive authentication (opens browser, prompts for token)
npm run benchmark:live -- --org-slug my-org

# With token provided directly
npm run benchmark:live -- --org-slug my-org --token $MCP_TOKEN

# Using staging environment
npm run benchmark:live -- --org-slug my-org --env staging

# Output as JSON
npm run benchmark:live -- --org-slug my-org --format json
```

### Authentication

When you run the benchmark without a `--token`, it uses **OAuth 2.0** with PKCE:

1. Registers a temporary CLI client with Airlock
2. Opens your browser to sign in
3. Receives the authorization code via local callback
4. Exchanges for an access token automatically

No manual token copying required! Just sign in and you're done.

If OAuth fails (e.g., firewall blocking localhost), it falls back to manual token entry.

### Live Benchmark Output

```
📊 Organization: my-org
   Timestamp: 2024-01-15T10:30:00.000Z

📦 Services (3):
   • Linear: 9 tools
   • GitHub: 18 tools
   • Google Calendar: 5 tools
   Total: 32 tools

📏 Token Measurements:
   Meta-tool definitions:    426 tokens (constant)
   list_services response:   180 tokens
   search_tools response:    250 tokens
   describe_tools response:  320 tokens
   Full expansion estimate:  4,480 tokens

⚖️  Fair Comparison:
   Meta-tools workflow:  2,028 tokens
   Full expansion:       4,480 tokens
   Savings:              2,452 tokens (54.7%)

💡 🟢 Meta-tools recommended - good savings
```

## Using Your Own OpenAPI Specs

Add your OpenAPI specs (JSON format) to `src/sample-specs/`:

```bash
cp your-api-spec.json src/sample-specs/
npm run benchmark
```

The benchmark automatically loads all `.json` files from the `sample-specs` directory.

## Fair Comparison

This benchmark accounts for the **full workflow overhead** of the meta-tools approach:

**Meta-tools workflow** (3 API calls):
1. `search_tools("create issue")` → returns matching tools (~150 tokens)
2. `describe_tools(["linear/create_issue"])` → returns full schema (~100 tokens)
3. `execute_tool("linear/create_issue", {...})` → executes

**Full expansion workflow** (1 API call):
1. Direct tool call → executes

### Overhead Calculation

Meta-tools workflow total: `(426 × 3) + 250 response tokens ≈ 1,528 tokens`

| Scenario | Full Expansion | Meta-tools (fair) | Difference |
|----------|----------------|-------------------|------------|
| Single API (5 tools) | 750 | 1,528 | ❌ +778 (meta costs more) |
| Single API (9 tools) | 936 | 1,528 | ❌ +592 (meta costs more) |
| Single API (18 tools) | 2,480 | 1,528 | ✅ -952 (38% savings) |
| Three APIs (32 tools) | 4,166 | 1,528 | ✅ -2,638 (63% savings) |
| Medium org (122 tools) | 12,248 | 1,528 | ✅ -10,720 (88% savings) |
| Large org (277 tools) | 26,167 | 1,528 | ✅ -24,639 (94% savings) |
| Enterprise (865 tools) | 79,019 | 1,528 | ✅ -77,491 (98% savings) |

**Break-even point**: ~15-20 total tools (typically 2 APIs)

## When to Use Each Approach

| Scenario | Tools | Recommendation | Fair Comparison |
|----------|-------|----------------|-----------------|
| Single small API | <10 | Full expansion | Meta costs ~600 more tokens |
| Single medium API | 10-20 | Either works | Roughly break-even |
| 2-3 APIs | 20-40 | Meta-tools | Saves 50-70% |
| 5+ APIs | 50-150 | Meta-tools | Saves 80-90% |
| Enterprise (10+ APIs) | 200+ | Meta-tools essential | Saves 95%+ |

## How It Works

### Token Counting

The benchmark uses a heuristic approximation of the cl100k_base tokenizer:
- Counts JSON structural characters
- Counts words (splitting camelCase)
- Averages with chars/4 estimate

For production accuracy, consider using [tiktoken](https://github.com/openai/tiktoken).

### Tool Schema Generation

OpenAPI specs are converted to MCP tool schemas:
- `operationId` → tool name
- `description` or `summary` → tool description
- Parameters + requestBody → `inputSchema`

## Contributing

Contributions welcome! Ideas:

- Add more sample API specs
- Integrate tiktoken for exact token counts
- Add live benchmark against real Airlock instance
- Visualization/charts

## Related

- [Airlock](https://www.air-lock.ai) - MCP server generator from OpenAPI specs
- [Model Context Protocol](https://modelcontextprotocol.io) - Open protocol for AI tool use
- [Anthropic Claude](https://claude.ai) - AI assistant that uses MCP

## License

MIT
