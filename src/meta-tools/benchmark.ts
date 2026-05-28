#!/usr/bin/env node
/**
 * Airlock Meta-Tools Token Savings Benchmark
 *
 * Compares token usage between:
 * 1. Meta-tools approach: 4 tools (list_services, search_tools, describe_tools, execute_tool)
 * 2. Full expansion approach: Every API endpoint exposed as an individual tool
 *
 * Run with: npm run benchmark
 * Or:       npx tsx src/benchmark.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { countTokens, countToolTokens, freeEncoder } from '../shared/token-counter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

interface OpenAPISpec {
  openapi: string;
  info: { title: string; description?: string; version: string };
  paths: Record<string, Record<string, OpenAPIOperation>>;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Record<string, unknown>;
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface BenchmarkResult {
  scenario: string;
  projectCount: number;
  totalTools: number;
  metaToolsTokens: number;
  fullExpansionTokens: number;
  tokensSaved: number;
  percentageSaved: number;
  costSavedPerReq: number; // Cost savings in dollars (per request)
  monthlySaved: number; // Monthly cost savings in dollars
}

// Cost per 1M input tokens (Claude Sonnet 4.5 pricing)
const COST_PER_MILLION_TOKENS = 3.0;

// Estimated monthly requests per user (~50 requests/day × 20 working days)
const MONTHLY_REQUESTS_PER_USER = 1_000;

// ============================================================================
// Meta-Tools Definition
//
// Airlock's `list_services` and `search_tools` descriptions are built
// dynamically from the org's connected service names (Airlock PR #1338, "fix:
// agents now reliably find your connected services"). Naming the services
// inline makes MCP hosts route discovery to Airlock instead of suggesting a
// separate connector. The names are capped at 12 with an "and N more" suffix,
// so the meta-tools footprint grows with org size but stays bounded — it is no
// longer the flat constant this benchmark used to assume. `describe_tools` and
// `execute_tool` carry no service names and stay fixed.
//
// The builders below mirror the server's logic so the simulated numbers track
// the real tool definitions the host receives on `initialize` / `tools/list`.
// ============================================================================

// Matches META_TOOL_DESCRIPTION_NAME_CAP in Airlock's meta-tools.ts.
const META_TOOL_DESCRIPTION_NAME_CAP = 12;

const LIST_SERVICES_DESCRIPTION_FALLBACK =
  'List all connected services (APIs) available in this organization. Call this first to discover what services are available, then use search_tools to find specific tools within a service.';

const SEARCH_TOOLS_DESCRIPTION_FALLBACK =
  'Search for available tools across all connected services in this organization. Use this to discover tools by keyword before executing them.';

function formatServiceNamesForDescription(names: string[]): string {
  const shown = names.slice(0, META_TOOL_DESCRIPTION_NAME_CAP);
  const remaining = names.length - shown.length;
  const joined = shown.join(', ');
  return remaining > 0 ? `${joined}, and ${remaining} more` : joined;
}

function buildListServicesDescription(serviceNames: string[]): string {
  if (serviceNames.length === 0) {
    return LIST_SERVICES_DESCRIPTION_FALLBACK;
  }
  const names = formatServiceNamesForDescription(serviceNames);
  return (
    `List the services (APIs) already connected to this organization — including ${names}. ` +
    "Call this first to discover what's available. These services are usable right now through Airlock, " +
    'so do NOT tell the user a capability is missing or suggest installing a separate connector/integration ' +
    'before checking here. Then use search_tools to find specific tools within a service.'
  );
}

function buildSearchToolsDescription(serviceNames: string[]): string {
  if (serviceNames.length === 0) {
    return SEARCH_TOOLS_DESCRIPTION_FALLBACK;
  }
  const names = formatServiceNamesForDescription(serviceNames);
  return (
    `Search for tools across all services connected to this organization — including ${names} — ` +
    'by keyword before executing them. If the user asks for a capability that maps to one of these ' +
    '(e.g. Notion, GitHub, Linear), search here first rather than suggesting they install a separate ' +
    'connector or integration; it is already connected through Airlock.'
  );
}

/** Sort service names the way the server does before embedding them. */
function sortServiceNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * Build the four meta-tool definitions for an org with the given connected
 * service names. `list_services` / `search_tools` embed the (sorted, capped)
 * names; the other two are static. Pass `[]` for the generic-fallback floor.
 */
function buildMetaTools(serviceNames: string[]): MCPTool[] {
  const sorted = sortServiceNames(serviceNames);
  return [
    {
      name: 'list_services',
      description: buildListServicesDescription(sorted),
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'search_tools',
      description: buildSearchToolsDescription(sorted),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query to match against tool names and descriptions',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 20)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'describe_tools',
      description:
        'Get detailed information and input schemas for specific tools. Use after search_tools to get full schemas before executing.',
      inputSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of tool names to describe (use namespaced format: project-slug/tool-name)',
          },
        },
        required: ['tools'],
      },
    },
    {
      name: 'execute_tool',
      description:
        'Execute a tool from any connected service in the organization. Use namespaced format: "project-slug/tool-name".',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'The namespaced tool name (e.g., "linear/create_issue", "github/create_pr")',
          },
          arguments: {
            type: 'object',
            additionalProperties: true,
            description: 'Arguments to pass to the tool',
          },
        },
        required: ['tool'],
      },
    },
  ];
}

// Generic-fallback floor (no services connected) — the smallest the meta-tools
// can be. Used for the per-tool breakdown reference; real scenarios embed names.
const BASE_META_TOOLS: MCPTool[] = buildMetaTools([]);

// ============================================================================
// OpenAPI to MCP Tool Conversion
// ============================================================================

function openApiToMcpTools(spec: OpenAPISpec): MCPTool[] {
  const tools: MCPTool[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method === 'parameters') continue; // Skip path-level parameters

      const op = operation as OpenAPIOperation;
      const name = op.operationId || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Add path and query parameters
      if (op.parameters) {
        for (const param of op.parameters) {
          properties[param.name] = {
            type: param.schema?.type || 'string',
            description: param.description || `${param.name} parameter`,
            ...(param.schema?.enum ? { enum: param.schema.enum } : {}),
          };
          if (param.required) {
            required.push(param.name);
          }
        }
      }

      // Add request body properties
      if (op.requestBody?.content) {
        const jsonContent = op.requestBody.content['application/json'];
        if (jsonContent?.schema) {
          const schema = jsonContent.schema as Record<string, unknown>;
          if (schema.properties) {
            Object.assign(properties, schema.properties);
          }
          if (schema.required && Array.isArray(schema.required)) {
            required.push(...schema.required);
          }
        }
      }

      tools.push({
        name,
        description: op.description || op.summary || `${method.toUpperCase()} ${path}`,
        inputSchema: {
          type: 'object',
          properties,
          required: [...new Set(required)],
        },
      });
    }
  }

  return tools;
}

// ============================================================================
// Spec Loading
// ============================================================================

function loadSampleSpecs(): Array<{ name: string; spec: OpenAPISpec }> {
  const specsDir = join(__dirname, 'sample-specs');
  const specs: Array<{ name: string; spec: OpenAPISpec }> = [];

  try {
    const files = readdirSync(specsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = readFileSync(join(specsDir, file), 'utf-8');
      const spec = JSON.parse(content) as OpenAPISpec;
      specs.push({
        name: spec.info.title,
        spec,
      });
    }
  } catch {
    console.error('Warning: Could not load sample specs from', specsDir);
  }

  return specs;
}

function generateSyntheticSpec(endpointCount: number): OpenAPISpec {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {};

  for (let i = 0; i < endpointCount; i++) {
    const resource = `resource${Math.floor(i / 5)}`;
    const pathIndex = i % 5;
    const pathTemplates = [
      `/${resource}`,
      `/${resource}/{id}`,
      `/${resource}/{id}/details`,
      `/${resource}/{id}/actions`,
      `/${resource}/search`,
    ];

    const path = pathTemplates[pathIndex];
    if (!paths[path]) {
      paths[path] = {};
    }

    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    const method = methods[i % methods.length];

    paths[path][method] = {
      operationId: `${method}_${resource}_${pathIndex}`,
      summary: `${method.toUpperCase()} operation for ${resource}`,
      description: `Performs a ${method} operation on the ${resource} resource.`,
      parameters: path.includes('{id}')
        ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
        : [],
      ...(method === 'post' || method === 'put' || method === 'patch'
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' },
                      status: { type: 'string', enum: ['active', 'inactive'] },
                    },
                    required: ['name'],
                  },
                },
              },
            },
          }
        : {}),
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: `Synthetic API (${endpointCount} endpoints)`,
      version: '1.0.0',
    },
    paths,
  };
}

// ============================================================================
// Benchmark Runner
// ============================================================================

function runBenchmark(
  scenario: string,
  specs: Array<{ name: string; spec: OpenAPISpec }>
): BenchmarkResult {
  // The meta-tools footprint depends on this scenario's connected services:
  // their names are embedded (capped at 12) into two of the four descriptions.
  const metaTools = buildMetaTools(specs.map(({ name }) => name));
  const metaToolsTokens = metaTools.reduce((sum, tool) => sum + countToolTokens(tool), 0);

  let totalTools = 0;
  let fullExpansionTokens = 0;

  for (const { spec } of specs) {
    const tools = openApiToMcpTools(spec);
    totalTools += tools.length;
    for (const tool of tools) {
      fullExpansionTokens += countToolTokens(tool);
    }
  }

  const tokensSaved = fullExpansionTokens - metaToolsTokens;
  const percentageSaved = fullExpansionTokens > 0 ? (tokensSaved / fullExpansionTokens) * 100 : 0;
  const costSavedPerReq = (tokensSaved / 1_000_000) * COST_PER_MILLION_TOKENS;
  const monthlySaved = costSavedPerReq * MONTHLY_REQUESTS_PER_USER;

  return {
    scenario,
    projectCount: specs.length,
    totalTools,
    metaToolsTokens,
    fullExpansionTokens,
    tokensSaved,
    percentageSaved,
    costSavedPerReq,
    monthlySaved,
  };
}

// ============================================================================
// Output Formatters
// ============================================================================

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  return n.toFixed(1) + '%';
}

function formatCost(tokens: number): string {
  const cost = (tokens / 1_000_000) * COST_PER_MILLION_TOKENS;
  if (cost < 0.01) {
    return '$' + cost.toFixed(4);
  }
  return '$' + cost.toFixed(3);
}

function formatMonthlyCost(dollars: number): string {
  if (dollars >= 1000) {
    return '$' + (dollars / 1000).toFixed(1) + 'k';
  }
  if (dollars >= 1) {
    return '$' + dollars.toFixed(0);
  }
  return '$' + dollars.toFixed(2);
}

function printResults(results: BenchmarkResult[], format: 'terminal' | 'json' | 'markdown'): void {
  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          results,
          meta: {
            // Per-scenario meta-tool token cost is in each result's
            // `metaToolsTokens`; it grows as connected-service names are embedded
            // into the list_services / search_tools descriptions (capped at 12).
            nameCap: META_TOOL_DESCRIPTION_NAME_CAP,
            baseMetaTools: BASE_META_TOOLS,
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (format === 'markdown') {
    printMarkdown(results);
    return;
  }

  printTerminal(results);
}

function printTerminal(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(100));
  console.log('AIRLOCK META-TOOLS TOKEN SAVINGS BENCHMARK');
  console.log('='.repeat(100));

  // Meta-tools breakdown. list_services / search_tools embed the org's
  // connected-service names (capped at 12), so they grow with org size; the
  // figures below are the generic-fallback floor (no services connected). The
  // per-scenario totals are in the Meta column of the results table.
  const growsWithOrg = new Set(['list_services', 'search_tools']);
  console.log('\n📦 Meta-Tools (4 tools) — floor (0 services connected):');
  console.log('-'.repeat(64));
  let totalMetaTokens = 0;
  for (const tool of BASE_META_TOOLS) {
    const tokens = countToolTokens(tool);
    totalMetaTokens += tokens;
    const note = growsWithOrg.has(tool.name) ? '  (+ service names, capped at 12)' : '';
    console.log(`  ${tool.name.padEnd(20)}: ${formatNumber(tokens).padStart(6)} tokens${note}`);
  }
  console.log('-'.repeat(64));
  console.log(`  ${'TOTAL'.padEnd(20)}: ${formatNumber(totalMetaTokens).padStart(6)} tokens`);

  // Results table
  console.log('\n📊 Benchmark Results:');
  console.log('-'.repeat(126));
  console.log(
    '| Scenario'.padEnd(40) +
      '| APIs'.padEnd(7) +
      '| Tools'.padEnd(8) +
      '| Meta'.padEnd(10) +
      '| Full'.padEnd(12) +
      '| Saved'.padEnd(12) +
      '| %'.padEnd(8) +
      '| $/req'.padEnd(10) +
      '| $/user/mo'.padEnd(12) +
      '|'
  );
  console.log('|' + '-'.repeat(38) + '|' + '-'.repeat(5) + '|' + '-'.repeat(6) + '|' + '-'.repeat(8) + '|' + '-'.repeat(10) + '|' + '-'.repeat(10) + '|' + '-'.repeat(6) + '|' + '-'.repeat(8) + '|' + '-'.repeat(10) + '|');

  for (const r of results) {
    console.log(
      '| ' +
        r.scenario.padEnd(37) +
        '| ' +
        r.projectCount.toString().padEnd(4) +
        '| ' +
        r.totalTools.toString().padEnd(5) +
        '| ' +
        formatNumber(r.metaToolsTokens).padEnd(7) +
        '| ' +
        formatNumber(r.fullExpansionTokens).padEnd(9) +
        '| ' +
        formatNumber(r.tokensSaved).padEnd(9) +
        '| ' +
        formatPercent(r.percentageSaved).padEnd(5) +
        '| ' +
        formatCost(r.tokensSaved).padEnd(7) +
        '| ' +
        formatMonthlyCost(r.monthlySaved).padEnd(9) +
        '|'
    );
  }
  console.log('-'.repeat(126));

  // Fair comparison
  console.log('\n⚖️  Fair Comparison (including meta-tools workflow overhead):');
  console.log('-'.repeat(70));

  const largeOrg = results.find((r) => r.totalTools > 100);
  if (largeOrg) {
    const searchDescribeOverhead = 300; // Approximate tokens for search + describe responses
    const metaWorkflowTotal = largeOrg.metaToolsTokens * 3 + searchDescribeOverhead;
    const fullWorkflowTotal = largeOrg.fullExpansionTokens;

    console.log(`  Scenario: ${largeOrg.scenario}`);
    console.log(`  Meta-tools workflow (search → describe → execute):`);
    console.log(`    3 API calls × ${largeOrg.metaToolsTokens} tool defs + ~${searchDescribeOverhead} response tokens`);
    console.log(`    Total: ~${formatNumber(metaWorkflowTotal)} tokens`);
    console.log(`  Full expansion workflow (direct execute):`);
    console.log(`    1 API call × ${formatNumber(largeOrg.fullExpansionTokens)} tool defs`);
    console.log(`    Total: ~${formatNumber(fullWorkflowTotal)} tokens`);
    console.log(`  Savings: ${formatNumber(fullWorkflowTotal - metaWorkflowTotal)} tokens (${formatPercent(((fullWorkflowTotal - metaWorkflowTotal) / fullWorkflowTotal) * 100)})`);
  }

  // Summary
  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));

  const maxSavings = Math.max(...results.map((r) => r.percentageSaved));
  const avgSavings = results.reduce((sum, r) => sum + r.percentageSaved, 0) / results.length;

  console.log(`
  Results across ${results.length} scenarios:
  • Maximum savings: ${formatPercent(maxSavings)}
  • Average savings: ${formatPercent(avgSavings)}
  • Break-even: ~15-20 tools (2-3 typical APIs)

  Meta-tools approach wins when you have multiple connected services.
`);
}

function printMarkdown(results: BenchmarkResult[]): void {
  console.log('# Airlock Meta-Tools Token Savings Benchmark\n');

  console.log('## Meta-Tools Definition (4 tools)\n');
  console.log(
    '`list_services` and `search_tools` embed the org\'s connected-service names ' +
      '(capped at 12) so MCP hosts route discovery to Airlock; their size grows with ' +
      'org size. Figures below are the generic-fallback floor (no services connected) — ' +
      'see the Meta Tokens column for per-scenario totals.\n'
  );
  const growsWithOrg = new Set(['list_services', 'search_tools']);
  console.log('| Tool | Tokens (floor) | Grows with org? |');
  console.log('|------|----------------|-----------------|');
  let totalMetaTokens = 0;
  for (const tool of BASE_META_TOOLS) {
    const tokens = countToolTokens(tool);
    totalMetaTokens += tokens;
    console.log(`| ${tool.name} | ${tokens} | ${growsWithOrg.has(tool.name) ? 'yes' : 'no'} |`);
  }
  console.log(`| **TOTAL** | **${totalMetaTokens}** | |\n`);

  console.log('## Benchmark Results\n');
  console.log('*Based on ~1,000 requests/user/month and Claude Sonnet 4.5 pricing ($3/1M input tokens)*\n');
  console.log('| Scenario | APIs | Tools | Meta Tokens | Full Tokens | Saved | % Saved | $/req | $/user/mo |');
  console.log('|----------|------|-------|-------------|-------------|-------|---------|-------|-----------|');
  for (const r of results) {
    console.log(
      `| ${r.scenario} | ${r.projectCount} | ${r.totalTools} | ${formatNumber(r.metaToolsTokens)} | ${formatNumber(r.fullExpansionTokens)} | ${formatNumber(r.tokensSaved)} | ${formatPercent(r.percentageSaved)} | ${formatCost(r.tokensSaved)} | ${formatMonthlyCost(r.monthlySaved)} |`
    );
  }

  console.log('\n## Key Findings\n');
  const maxSavings = Math.max(...results.map((r) => r.percentageSaved));
  const avgSavings = results.reduce((sum, r) => sum + r.percentageSaved, 0) / results.length;
  console.log(`- **Maximum savings**: ${formatPercent(maxSavings)}`);
  console.log(`- **Average savings**: ${formatPercent(avgSavings)}`);
  console.log('- **Break-even point**: ~15-20 tools (2-3 typical APIs)');
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  const args = process.argv.slice(2);
  const format = args.includes('--format')
    ? (args[args.indexOf('--format') + 1] as 'terminal' | 'json' | 'markdown')
    : 'terminal';

  if (format === 'terminal') {
    console.log('\n🔬 Running Airlock Meta-Tools Benchmark...\n');
  }

  const sampleSpecs = loadSampleSpecs();
  const results: BenchmarkResult[] = [];

  // Single API scenarios
  for (const spec of sampleSpecs) {
    results.push(runBenchmark(`Single API (${spec.name})`, [spec]));
  }

  // Multi-API scenarios
  if (sampleSpecs.length >= 2) {
    results.push(runBenchmark('Two APIs', sampleSpecs.slice(0, 2)));
  }
  if (sampleSpecs.length >= 3) {
    results.push(runBenchmark('Three APIs (typical org)', sampleSpecs.slice(0, 3)));
  }

  // Synthetic large scenarios
  const syntheticLarge = generateSyntheticSpec(50);
  results.push(
    runBenchmark('Medium org (5 APIs)', [
      ...sampleSpecs.slice(0, 3).map((s) => ({ name: s.name, spec: s.spec })),
      { name: 'Service A', spec: syntheticLarge },
      { name: 'Service B', spec: generateSyntheticSpec(40) },
    ])
  );

  results.push(
    runBenchmark('Large org (10 APIs)', [
      ...sampleSpecs.map((s) => ({ name: s.name, spec: s.spec })),
      ...Array.from({ length: 7 }, (_, i) => ({
        name: `Service ${i + 1}`,
        spec: generateSyntheticSpec(20 + i * 5),
      })),
    ])
  );

  results.push(
    runBenchmark('Enterprise (20 APIs)', [
      ...sampleSpecs.map((s) => ({ name: s.name, spec: s.spec })),
      ...Array.from({ length: 17 }, (_, i) => ({
        name: `Service ${i + 1}`,
        spec: generateSyntheticSpec(25 + i * 3),
      })),
    ])
  );

  printResults(results, format);

  // Clean up tiktoken encoder
  freeEncoder();
}

main();
