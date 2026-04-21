#!/usr/bin/env node
/**
 * Live Meta-Tools Benchmark
 *
 * Measures actual meta-tools token usage against a real Airlock organization
 * by calling list_services / search_tools / describe_tools and counting the
 * response sizes with tiktoken.
 *
 * Usage:
 *   npm run benchmark:meta:live -- --org <slug>
 *   npm run benchmark:meta:live -- --org <slug> --token <mcp-token>
 */

import { parseArgs } from 'util';
import { countTokens, freeEncoder } from '../shared/token-counter.js';
import { interactiveAuth, resolveAirlockUrl } from '../shared/oauth.js';
import { MCPClient } from '../shared/mcp-client.js';

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
  tools: Array<{ name: string; description: string; project: string }>;
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
  services: { count: number; names: string[] };
  tools: { total: number; perService: Record<string, number> };
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

// Meta-tools token count (measured with tiktoken cl100k_base)
const META_TOOLS_TOKENS = 457;

async function runLiveBenchmark(
  url: string,
  token: string,
): Promise<LiveBenchmarkResult> {
  console.log('\n🔌 Connecting to Airlock MCP endpoint...');
  console.log(`   URL: ${url}\n`);

  const client = new MCPClient(url, token);

  console.log('📡 Initializing MCP session...');
  await client.initialize();
  console.log('   ✓ Connected\n');

  console.log('🔧 Fetching tool list...');
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  console.log(
    `   ✓ Found ${toolsResult.tools.length} tools: ${toolNames.join(', ')}\n`,
  );

  const expectedTools = ['list_services', 'search_tools', 'describe_tools', 'execute_tool'];
  if (!expectedTools.every((t) => toolNames.includes(t))) {
    console.log(
      '   ⚠️  Warning: Expected meta-tools not found. This may be a project-specific endpoint.\n',
    );
  }

  console.log('📋 Calling list_services...');
  const listServicesText = await client.callToolText('list_services', {});
  const listServicesData = JSON.parse(listServicesText) as ListServicesResult;
  const listServicesTokens = countTokens(listServicesText);
  console.log(`   ✓ Found ${listServicesData.total} services`);
  console.log(`   ✓ Response size: ${listServicesTokens} tokens\n`);

  const serviceNames = listServicesData.services.map((s) => s.name);
  const toolsPerService: Record<string, number> = {};
  let totalTools = 0;
  for (const service of listServicesData.services) {
    toolsPerService[service.name] = service.toolCount;
    totalTools += service.toolCount;
  }

  console.log('🔍 Calling search_tools...');
  const searchToolsText = await client.callToolText('search_tools', {
    query: 'create',
    limit: 50,
  });
  const searchToolsData = JSON.parse(searchToolsText) as SearchToolsResult;
  const searchToolsTokens = countTokens(searchToolsText);
  console.log(`   ✓ Found ${searchToolsData.total} matching tools`);
  console.log(`   ✓ Response size: ${searchToolsTokens} tokens\n`);

  const sampleTools = searchToolsData.tools.slice(0, 5).map((t) => t.name);
  console.log(`📖 Calling describe_tools for ${sampleTools.length} tools...`);
  const describeToolsText = await client.callToolText('describe_tools', {
    tools: sampleTools,
  });
  const describeToolsData = JSON.parse(describeToolsText) as DescribeToolsResult;
  const describeToolsTokens = countTokens(describeToolsText);
  console.log(`   ✓ Described ${describeToolsData.tools.length} tools`);
  console.log(`   ✓ Response size: ${describeToolsTokens} tokens\n`);

  const avgTokensPerTool = 140;
  const fullExpansionEstimate = totalTools * avgTokensPerTool;

  const metaToolsWorkflow =
    META_TOOLS_TOKENS * 3 +
    listServicesTokens +
    searchToolsTokens +
    describeToolsTokens;
  const difference = fullExpansionEstimate - metaToolsWorkflow;
  const percentageSaved =
    fullExpansionEstimate > 0 ? (difference / fullExpansionEstimate) * 100 : 0;

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

  const orgSlug = url.match(/\/org\/([^/?]+)/)?.[1] || 'unknown';

  return {
    orgSlug,
    timestamp: new Date().toISOString(),
    services: { count: listServicesData.total, names: serviceNames },
    tools: { total: totalTools, perService: toolsPerService },
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

function printResult(
  result: LiveBenchmarkResult,
  format: 'terminal' | 'json',
): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('='.repeat(70));
  console.log('LIVE META-TOOLS BENCHMARK RESULTS');
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
  console.log(
    `   Meta-tool definitions:    ${result.tokenMeasurements.metaToolDefinitions} tokens (constant)`,
  );
  console.log(
    `   list_services response:   ${result.tokenMeasurements.listServicesResponse} tokens`,
  );
  console.log(
    `   search_tools response:    ${result.tokenMeasurements.searchToolsResponse} tokens`,
  );
  console.log(
    `   describe_tools response:  ${result.tokenMeasurements.describeToolsResponse} tokens`,
  );
  console.log(
    `   Full expansion estimate:  ${result.tokenMeasurements.fullExpansionEstimate.toLocaleString()} tokens`,
  );

  console.log('\n⚖️  Fair Comparison:');
  console.log(
    `   Meta-tools workflow:  ${result.fairComparison.metaToolsWorkflow.toLocaleString()} tokens`,
  );
  console.log(
    `   Full expansion:       ${result.fairComparison.fullExpansion.toLocaleString()} tokens`,
  );

  if (result.fairComparison.difference > 0) {
    console.log(
      `   Savings:              ${result.fairComparison.difference.toLocaleString()} tokens (${result.fairComparison.percentageSaved.toFixed(1)}%)`,
    );
  } else {
    console.log(
      `   Extra cost:           ${Math.abs(result.fairComparison.difference).toLocaleString()} tokens`,
    );
  }

  console.log(`\n💡 ${result.fairComparison.recommendation}`);
  console.log('='.repeat(70));
}

function printUsage(): void {
  console.log(`
Airlock Live Meta-Tools Benchmark — measure actual token usage against your Airlock instance.

Usage:
  npm run benchmark:meta:live -- --org <slug>
  npm run benchmark:meta:live -- --org <slug> --token <token>

Options:
  --org <slug>      Your Airlock organization slug (required unless --url)
  --url <url>       Full MCP endpoint URL (alternative to --org)
  --token <token>   Your MCP access token (will prompt via OAuth if not provided)
  --env <env>       Environment: production (default), staging, or <stage> for dev
  --format <fmt>    Output format: terminal (default) or json
  --help            Show this help message
`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      env: { type: 'string', default: 'production' },
      format: { type: 'string', default: 'terminal' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  const env = values.env || 'production';
  let url: string;
  if (values.url) {
    url = values.url;
  } else if (values.org) {
    url = resolveAirlockUrl(values.org, env);
  } else {
    console.error('Error: Either --org or --url is required\n');
    printUsage();
    process.exit(1);
  }

  let token = values.token;
  if (!token) {
    const mcpBaseUrl = url.replace(/\/org\/[^/]+$/, '');
    try {
      token = await interactiveAuth(mcpBaseUrl);
    } catch (error) {
      console.error(
        '\n❌ Authentication failed:',
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  }

  const format = (values.format as 'terminal' | 'json') || 'terminal';

  try {
    const result = await runLiveBenchmark(url, token);
    printResult(result, format);
  } catch (error) {
    console.error(
      '\n❌ Benchmark failed:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  } finally {
    freeEncoder();
  }
}

main();
