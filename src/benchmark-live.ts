#!/usr/bin/env node
/**
 * Live Benchmark - Measure actual token usage against a real Airlock instance
 *
 * Connects to your Airlock organization endpoint and measures real response sizes
 * to provide accurate token comparisons.
 *
 * Usage:
 *   npx tsx src/benchmark-live.ts --org-slug <slug> --token <mcp-token>
 *   npx tsx src/benchmark-live.ts --url <full-mcp-url> --token <mcp-token>
 */

import { parseArgs } from 'util';

// ============================================================================
// Types
// ============================================================================

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ListServicesResult {
  services: Array<{
    name: string;
    slug: string;
    toolCount: number;
    sampleTools: string[];
  }>;
  total: number;
}

interface SearchToolsResult {
  tools: Array<{
    name: string;
    description: string;
    project: string;
  }>;
  total: number;
}

interface DescribeToolsResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    project: string;
  }>;
  notFound: string[];
}

interface LiveBenchmarkResult {
  orgSlug: string;
  timestamp: string;
  services: {
    count: number;
    names: string[];
  };
  tools: {
    total: number;
    perService: Record<string, number>;
  };
  tokenMeasurements: {
    listServicesResponse: number;
    searchToolsResponse: number;
    describeToolsResponse: number;
    metaToolDefinitions: number;
    fullExpansionEstimate: number;
  };
  fairComparison: {
    metaToolsWorkflow: number;
    fullExpansion: number;
    difference: number;
    percentageSaved: number;
    recommendation: string;
  };
}

// ============================================================================
// Token Counting
// ============================================================================

function countTokens(text: string): number {
  const structuralChars = (text.match(/[{}\[\]:,"]/g) || []).length;
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const estimate = Math.ceil(structuralChars * 0.5 + words.length * 1.3);
  const simpleEstimate = Math.ceil(text.length / 4);

  return Math.ceil((estimate + simpleEstimate) / 2);
}

// Meta-tools token count (constant)
const META_TOOLS_TOKENS = 426;

// ============================================================================
// MCP Client
// ============================================================================

class MCPClient {
  private baseUrl: string;
  private token: string;
  private requestId = 0;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const body: MCPRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      ...(params && { params }),
    };

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}\n${text}`);
    }

    const data = (await response.json()) as MCPResponse;

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message} (code: ${data.error.code})`);
    }

    return data.result as T;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'airlock-benchmark', version: '1.0.0' },
    });
  }

  async listTools(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }> {
    return this.request('tools/list');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
    return this.request('tools/call', { name, arguments: args });
  }
}

// ============================================================================
// Live Benchmark
// ============================================================================

async function runLiveBenchmark(url: string, token: string): Promise<LiveBenchmarkResult> {
  console.log('\n🔌 Connecting to Airlock MCP endpoint...');
  console.log(`   URL: ${url}\n`);

  const client = new MCPClient(url, token);

  // Initialize connection
  console.log('📡 Initializing MCP session...');
  await client.initialize();
  console.log('   ✓ Connected\n');

  // Get available tools (should be the 4 meta-tools)
  console.log('🔧 Fetching tool list...');
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  console.log(`   ✓ Found ${toolsResult.tools.length} tools: ${toolNames.join(', ')}\n`);

  // Verify we have meta-tools
  const expectedTools = ['list_services', 'search_tools', 'describe_tools', 'execute_tool'];
  const hasMetaTools = expectedTools.every((t) => toolNames.includes(t));

  if (!hasMetaTools) {
    console.log('   ⚠️  Warning: Expected meta-tools not found. This may be a project-specific endpoint.\n');
  }

  // Call list_services
  console.log('📋 Calling list_services...');
  const listServicesRaw = await client.callTool('list_services', {});
  const listServicesText = listServicesRaw.content[0]?.text || '{}';
  const listServicesData = JSON.parse(listServicesText) as ListServicesResult;
  const listServicesTokens = countTokens(listServicesText);
  console.log(`   ✓ Found ${listServicesData.total} services`);
  console.log(`   ✓ Response size: ${listServicesTokens} tokens\n`);

  // Build service summary
  const serviceNames = listServicesData.services.map((s) => s.name);
  const toolsPerService: Record<string, number> = {};
  let totalTools = 0;
  for (const service of listServicesData.services) {
    toolsPerService[service.name] = service.toolCount;
    totalTools += service.toolCount;
  }

  // Call search_tools with a broad query
  console.log('🔍 Calling search_tools...');
  const searchToolsRaw = await client.callTool('search_tools', { query: 'create', limit: 50 });
  const searchToolsText = searchToolsRaw.content[0]?.text || '{}';
  const searchToolsData = JSON.parse(searchToolsText) as SearchToolsResult;
  const searchToolsTokens = countTokens(searchToolsText);
  console.log(`   ✓ Found ${searchToolsData.total} matching tools`);
  console.log(`   ✓ Response size: ${searchToolsTokens} tokens\n`);

  // Call describe_tools for a sample of tools
  const sampleTools = searchToolsData.tools.slice(0, 5).map((t) => t.name);
  console.log(`📖 Calling describe_tools for ${sampleTools.length} tools...`);
  const describeToolsRaw = await client.callTool('describe_tools', { tools: sampleTools });
  const describeToolsText = describeToolsRaw.content[0]?.text || '{}';
  const describeToolsData = JSON.parse(describeToolsText) as DescribeToolsResult;
  const describeToolsTokens = countTokens(describeToolsText);
  console.log(`   ✓ Described ${describeToolsData.tools.length} tools`);
  console.log(`   ✓ Response size: ${describeToolsTokens} tokens\n`);

  // Estimate full expansion tokens
  // Average ~140 tokens per tool based on static benchmarks
  const avgTokensPerTool = 140;
  const fullExpansionEstimate = totalTools * avgTokensPerTool;

  // Calculate fair comparison
  // Meta-tools workflow: 3 API calls with tool definitions + response tokens
  const metaToolsWorkflow = META_TOOLS_TOKENS * 3 + listServicesTokens + searchToolsTokens + describeToolsTokens;
  const difference = fullExpansionEstimate - metaToolsWorkflow;
  const percentageSaved = fullExpansionEstimate > 0 ? (difference / fullExpansionEstimate) * 100 : 0;

  let recommendation: string;
  if (percentageSaved > 80) {
    recommendation = '🟢 Meta-tools strongly recommended - significant savings';
  } else if (percentageSaved > 50) {
    recommendation = '🟢 Meta-tools recommended - good savings';
  } else if (percentageSaved > 0) {
    recommendation = '🟡 Meta-tools slightly better - marginal savings';
  } else {
    recommendation = '🔴 Full expansion may be better for this small setup';
  }

  // Extract org slug from URL
  const orgSlug = url.match(/\/org\/([^/?]+)/)?.[1] || 'unknown';

  return {
    orgSlug,
    timestamp: new Date().toISOString(),
    services: {
      count: listServicesData.total,
      names: serviceNames,
    },
    tools: {
      total: totalTools,
      perService: toolsPerService,
    },
    tokenMeasurements: {
      listServicesResponse: listServicesTokens,
      searchToolsResponse: searchToolsTokens,
      describeToolsResponse: describeToolsTokens,
      metaToolDefinitions: META_TOOLS_TOKENS,
      fullExpansionEstimate,
    },
    fairComparison: {
      metaToolsWorkflow,
      fullExpansion: fullExpansionEstimate,
      difference,
      percentageSaved,
      recommendation,
    },
  };
}

// ============================================================================
// Output
// ============================================================================

function printResult(result: LiveBenchmarkResult, format: 'terminal' | 'json'): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('='.repeat(70));
  console.log('LIVE BENCHMARK RESULTS');
  console.log('='.repeat(70));

  console.log(`\n📊 Organization: ${result.orgSlug}`);
  console.log(`   Timestamp: ${result.timestamp}`);

  console.log(`\n📦 Services (${result.services.count}):`);
  for (const name of result.services.names) {
    const tools = result.tools.perService[name];
    console.log(`   • ${name}: ${tools} tools`);
  }
  console.log(`   Total: ${result.tools.total} tools`);

  console.log('\n📏 Token Measurements:');
  console.log(`   Meta-tool definitions:    ${result.tokenMeasurements.metaToolDefinitions} tokens (constant)`);
  console.log(`   list_services response:   ${result.tokenMeasurements.listServicesResponse} tokens`);
  console.log(`   search_tools response:    ${result.tokenMeasurements.searchToolsResponse} tokens`);
  console.log(`   describe_tools response:  ${result.tokenMeasurements.describeToolsResponse} tokens`);
  console.log(`   Full expansion estimate:  ${result.tokenMeasurements.fullExpansionEstimate.toLocaleString()} tokens`);

  console.log('\n⚖️  Fair Comparison:');
  console.log(`   Meta-tools workflow:  ${result.fairComparison.metaToolsWorkflow.toLocaleString()} tokens`);
  console.log(`   Full expansion:       ${result.fairComparison.fullExpansion.toLocaleString()} tokens`);

  if (result.fairComparison.difference > 0) {
    console.log(`   Savings:              ${result.fairComparison.difference.toLocaleString()} tokens (${result.fairComparison.percentageSaved.toFixed(1)}%)`);
  } else {
    console.log(`   Extra cost:           ${Math.abs(result.fairComparison.difference).toLocaleString()} tokens`);
  }

  console.log(`\n💡 ${result.fairComparison.recommendation}`);
  console.log('='.repeat(70));
}

// ============================================================================
// CLI
// ============================================================================

function printUsage(): void {
  console.log(`
Airlock Live Benchmark - Measure actual token usage against your Airlock instance

Usage:
  npx tsx src/benchmark-live.ts --org-slug <slug> --token <token>
  npx tsx src/benchmark-live.ts --url <full-url> --token <token>

Options:
  --org-slug <slug>   Your Airlock organization slug
  --url <url>         Full MCP endpoint URL (alternative to --org-slug)
  --token <token>     Your MCP access token
  --env <env>         Environment: production (default), staging, or dev
  --format <format>   Output format: terminal (default) or json
  --help              Show this help message

Examples:
  # Using org slug (production)
  npx tsx src/benchmark-live.ts --org-slug my-org --token abc123

  # Using org slug (staging)
  npx tsx src/benchmark-live.ts --org-slug my-org --token abc123 --env staging

  # Using full URL
  npx tsx src/benchmark-live.ts --url https://mcp.air-lock.ai/org/my-org --token abc123

Environment URLs:
  production:  https://mcp.air-lock.ai/org/<slug>
  staging:     https://mcp.staging.air-lock.ai/org/<slug>
  dev:         https://mcp.<stage>.dev.air-lock.ai/org/<slug>
`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'org-slug': { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      env: { type: 'string', default: 'production' },
      format: { type: 'string', default: 'terminal' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.token) {
    console.error('Error: --token is required\n');
    printUsage();
    process.exit(1);
  }

  let url: string;

  if (values.url) {
    url = values.url;
  } else if (values['org-slug']) {
    const slug = values['org-slug'];
    const env = values.env || 'production';

    switch (env) {
      case 'production':
        url = `https://mcp.air-lock.ai/org/${slug}`;
        break;
      case 'staging':
        url = `https://mcp.staging.air-lock.ai/org/${slug}`;
        break;
      default:
        // Dev environment - env is the stage name
        url = `https://mcp.${env}.dev.air-lock.ai/org/${slug}`;
    }
  } else {
    console.error('Error: Either --org-slug or --url is required\n');
    printUsage();
    process.exit(1);
  }

  const format = (values.format as 'terminal' | 'json') || 'terminal';

  try {
    const result = await runLiveBenchmark(url, values.token);
    printResult(result, format);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
