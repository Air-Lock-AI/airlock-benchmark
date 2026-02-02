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
1. `search_tools("create issue")` → returns matching tools
2. `describe_tools(["linear/create_issue"])` → returns full schema
3. `execute_tool("linear/create_issue", {...})` → executes

**Full expansion workflow** (1 API call):
1. Direct tool call → executes

Even with this overhead, meta-tools saves **90%+ tokens** for organizations with 3+ APIs.

## When to Use Each Approach

| Scenario | Recommendation |
|----------|----------------|
| Single API with <10 tools | Full expansion acceptable |
| 2-3 APIs | Meta-tools starts winning |
| 5+ APIs | Meta-tools clearly better |
| Enterprise (10+ APIs) | Meta-tools essential |

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
