# Airlock Benchmarks

Reproducible token-savings benchmarks for [Airlock](https://www.air-lock.ai). Two scopes, one repo:

| Benchmark | What it measures |
|-----------|------------------|
| **Meta-tools** (`npm run benchmark:meta`) | Savings from exposing **4 meta-tools** (`list_services`, `search_tools`, `describe_tools`, `execute_tool`) instead of full OpenAPI expansion (N tool definitions per connected API). |
| **Airlock Code** (`npm run benchmark:code`) | Savings from calling Airlock Code's `code_review_context` instead of reading changed files directly. Mirrors the methodology of [code-review-graph](https://github.com/tirth8205/code-review-graph) so the numbers compare row-for-row. |

Both benchmarks have a deterministic simulated mode that runs offline, and a `--live` variant that measures against your real Airlock instance.

## Quick Start

```bash
git clone https://github.com/Air-Lock-AI/airlock-benchmark.git
cd airlock-benchmark
npm install

# Run both benchmarks (simulated — no Airlock instance required)
npm run benchmark

# Just one of them
npm run benchmark:meta
npm run benchmark:code
```

---

## Meta-tools Benchmark

When exposing APIs to AI agents via MCP there are two approaches:

- **Full expansion** — every endpoint becomes its own MCP tool. 10 APIs × 30 endpoints = **300 tool definitions** sent on every message.
- **Meta-tools** — Airlock exposes **4 tools** regardless of how many APIs are connected. The agent discovers specific tools via `search_tools` / `describe_tools` and invokes them through `execute_tool`.

### Sample output

```
📦 Meta-Tools (4 tools):
  list_services       :     63 tokens
  search_tools        :    130 tokens
  describe_tools      :    120 tokens
  execute_tool        :    144 tokens
  TOTAL               :    457 tokens

📊 Benchmark Results:
| Scenario                 | APIs | Tools | Meta | Full    | Saved   | %     | $/user/mo |
|--------------------------|------|-------|------|---------|---------|-------|-----------|
| Single API (Linear)      | 1    | 9     | 457  | 1,091   | 634     | 58.1% | $1.90     |
| Three APIs (typical org) | 3    | 32    | 457  | 4,878   | 4,421   | 90.6% | $13.26    |
| Large org (10 APIs)      | 10   | 277   | 457  | 31,485  | 31,028  | 98.5% | $93.08    |
```

*Based on ~1,000 requests/user/month at Claude Sonnet 4.5 pricing ($3/1M input tokens).*

### Output formats

```bash
npm run benchmark:meta                 # terminal
npm run benchmark:meta:json            # JSON
npm run benchmark:meta:markdown        # markdown table
```

### Live meta-tools benchmark (against your Airlock instance)

```bash
npm run benchmark:meta:live -- --org my-org
npm run benchmark:meta:live -- --org my-org --token $MCP_TOKEN
npm run benchmark:meta:live -- --org my-org --env staging
```

Without `--token`, OAuth 2.0 + PKCE opens your browser, completes sign-in, and retrieves a token automatically. If OAuth fails it falls back to manual token paste.

### Using your own OpenAPI specs

```bash
cp your-api-spec.json src/meta-tools/sample-specs/
npm run benchmark:meta
```

All `.json` files in `src/meta-tools/sample-specs/` are loaded as scenarios.

---

## Airlock Code Benchmark

Airlock Code ships 16 MCP tools that query a structural graph of your indexed repositories (symbols, calls, imports, tests, flows). Instead of asking the agent to read every changed file to answer "what breaks if this PR lands?", it returns a compact graph response scoped to the blast radius.

This benchmark replicates the methodology used by [code-review-graph](https://github.com/tirth8205/code-review-graph) — same six repos, same thirteen commits, same three token metrics — so Airlock Code's ratios compare directly to theirs.

### Methodology

For each commit in the fixture set, we compute:

| Metric | How it's computed |
|--------|-------------------|
| `naive_tokens` | `sum(tiktoken(file_content))` over every changed file — what an agent would burn reading each changed file end-to-end. |
| `standard_tokens` | `tiktoken(git diff -U3 <sha>~1 <sha>)` — the unified diff itself. |
| `graph_tokens` | `tiktoken(JSON.stringify(code_review_context response))` — what Airlock Code would return for the same PR review. |

Ratios are reported as `naive / graph` and `standard / graph`. All three counts use tiktoken's `cl100k_base` encoding.

The fixture set (locked to specific SHAs for reproducibility):

| Repo | Commits | Language | Size |
|------|--------:|----------|------|
| [express](https://github.com/expressjs/express) | 2 | JavaScript | small |
| [fastapi](https://github.com/tiangolo/fastapi) | 2 | Python | medium |
| [flask](https://github.com/pallets/flask) | 2 | Python | small |
| [gin](https://github.com/gin-gonic/gin) | 3 | Go | small |
| [httpx](https://github.com/encode/httpx) | 2 | Python | small |
| nextjs (label) | 2 | Python | medium |

### Simulated mode (default)

```bash
npm run benchmark:code                            # terminal
npm run benchmark:code:json                       # JSON
npm run benchmark:code:markdown                   # markdown
npm run benchmark:code -- --only httpx            # single repo
npm run benchmark:code -- --report                # also writes evaluate/reports/summary.md
```

The first run clones the fixture repos into `.cache/airlock-code-repos/` (git-ignored). Subsequent runs only fetch missing commits, so they take a few seconds.

The `graph_tokens` column is simulated — we generate a response matching the exact shape Airlock's `code_review_context` SQL returns (`{rows, count, truncated}` with `{category, name, entity_type, confidence}` rows), sized from the actual symbol counts in the changed files. Use `--live` below to replace the simulation with real measurements.

### Your-own-PRs mode

The fixture set is for reproducibility; for "how much would we save on our own PRs?", point at any GitHub repo and a list of PR numbers (or the last N merged PRs). Works with private repos via `gh auth`.

```bash
# Last 20 merged PRs from your repo
npm run benchmark:code -- --repo Air-Lock-AI/airlock --last 20

# Specific PRs
npm run benchmark:code -- --repo Air-Lock-AI/airlock --pr 1105,1104,1103

# Use an existing local clone (no re-clone, no working-tree mutation)
npm run benchmark:code -- --repo Air-Lock-AI/airlock --last 20 \
    --local-repo ~/projects/airlock

# Raw commit SHAs
npm run benchmark:code -- --repo Air-Lock-AI/airlock --sha abc123,def456
```

All file reads go through `git show <sha>:<path>`, so `--local-repo` never touches the working tree — safe to run against a checkout with in-flight work. The live variant accepts the same flags and calls `code_review_context` against your Airlock org:

```bash
npm run benchmark:code:live -- --org my-org --repo Air-Lock-AI/airlock --last 20 \
    --local-repo ~/projects/airlock --report
```

The repo must be connected to your Airlock Code org (the benchmark passes `repository=github:<owner>/<name>` to scope the query). Commits whose repo isn't indexed are skipped with a warning.

### Live mode (against your Airlock Code instance)

```bash
npm run benchmark:code:live -- --org my-org
npm run benchmark:code:live -- --org my-org --only httpx
npm run benchmark:code:live -- --url https://mcp.air-lock.ai/org/my-org --token $MCP_TOKEN
```

Each fixture repo must be connected to your Airlock org — the benchmark passes `repository=github:<owner>/<repo>` so the graph query scopes to the commit's repo. If a repo isn't indexed, that commit is skipped with a warning.

Pass `--report` to drop a timestamped `summary-live-<org>.md` into `evaluate/reports/`.

### Directory layout

```
src/
  shared/
    token-counter.ts        # tiktoken cl100k_base
    oauth.ts                # OAuth + PKCE + manual-token fallback
    mcp-client.ts           # JSON-RPC 2.0 MCP client
  meta-tools/
    benchmark.ts            # simulated meta-tools comparison
    benchmark-live.ts       # live against a real Airlock org
    sample-specs/           # OpenAPI specs driving the scenarios
  airlock-code/
    benchmark.ts            # simulated token-efficiency run
    benchmark-live.ts       # live — calls real code_review_context
    fixtures.ts             # 6 repos × 13 commits (mirrors code-review-graph)
    token-efficiency.ts     # naive / standard / graph token calculations
    simulate-response.ts    # simulated code_review_context response shape
```

---

## Why two benchmarks?

They answer different questions:

- **Meta-tools** is a per-request overhead question: "how many tool-definition tokens does the agent pay on every message?" The win scales with how many APIs are connected — negligible at 1 API, ~98% savings at 10+.
- **Airlock Code** is a per-task overhead question: "how many tokens does the agent burn answering one structural question about the codebase?" The win scales with repo size — small single-file PRs can be cheaper to read directly; medium and large PRs save 5–20×.

A production Airlock deployment typically benefits from both, and they compose: the meta-tools layer keeps the tool list small, and Airlock Code keeps the responses inside those tools small.

## Related

- [Airlock](https://www.air-lock.ai) — MCP server generator with meta-tools + Airlock Code
- [code-review-graph](https://github.com/tirth8205/code-review-graph) — the benchmark whose token_efficiency methodology we mirror
- [Model Context Protocol](https://modelcontextprotocol.io) — open protocol for AI tool use

## License

MIT
