#!/usr/bin/env node
/**
 * Live Benchmark - Measure actual token usage against a real Airlock instance
 *
 * Connects to your Airlock organization endpoint and measures real response sizes
 * to provide accurate token comparisons.
 *
 * Usage:
 *   npx tsx src/benchmark-live.ts --org <slug>
 *   npx tsx src/benchmark-live.ts --org <slug> --token <mcp-token>
 */

import { parseArgs } from 'util';
import { createInterface } from 'readline';
import { exec } from 'child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';

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
// OAuth Authentication
// ============================================================================

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported: string[];
  code_challenge_methods_supported?: string[];
}

interface OAuthClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;

  switch (platform) {
    case 'darwin':
      command = `open "${url}"`;
      break;
    case 'win32':
      command = `start "" "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`\n   Could not open browser automatically.`);
      console.log(`   Please open this URL manually: ${url}\n`);
    }
  });
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(digest).toString('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

async function fetchOAuthMetadata(mcpBaseUrl: string): Promise<OAuthMetadata> {
  const metadataUrl = `${mcpBaseUrl}/.well-known/oauth-authorization-server`;
  const response = await fetch(metadataUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch OAuth metadata: ${response.status}`);
  }

  return response.json() as Promise<OAuthMetadata>;
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<OAuthClientRegistration> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Airlock Benchmark CLI',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to register OAuth client: ${response.status} ${text}`);
  }

  return response.json() as Promise<OAuthClientRegistration>;
}

async function exchangeCodeForToken(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<OAuthTokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to exchange code for token: ${response.status} ${text}`);
  }

  return response.json() as Promise<OAuthTokenResponse>;
}

function startCallbackServer(port: number): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authentication Failed</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1 style="color: #dc3545;">Authentication Failed</h1>
  <p>Error: ${error}</p>
  <p>You can close this window.</p>
</body>
</html>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code && state) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Authentication Successful</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
  <h1 style="color: #28a745;">Authentication Successful</h1>
  <p>You can close this window and return to the terminal.</p>
  <script>window.close();</script>
</body>
</html>`);
          server.close();
          resolve({ code, state });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing code or state parameter');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    server.listen(port, '127.0.0.1', () => {
      // Server started
    });

    server.on('error', (err) => {
      reject(err);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out'));
    }, 5 * 60 * 1000);
  });
}

async function oauthAuthenticate(mcpBaseUrl: string): Promise<string> {
  console.log('\n🔐 OAuth Authentication\n');

  // Find an available port
  const port = 9876 + Math.floor(Math.random() * 100);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Fetch OAuth metadata
  console.log('   📡 Fetching OAuth configuration...');
  const metadata = await fetchOAuthMetadata(mcpBaseUrl);
  console.log('   ✓ OAuth server found\n');

  // Register client dynamically
  if (!metadata.registration_endpoint) {
    throw new Error('OAuth server does not support dynamic client registration');
  }

  console.log('   📝 Registering CLI client...');
  const client = await registerClient(metadata.registration_endpoint, redirectUri);
  console.log('   ✓ Client registered\n');

  // Generate PKCE challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Build authorization URL
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // Start callback server
  const callbackPromise = startCallbackServer(port);

  // Open browser
  console.log('   🌐 Opening browser for authentication...');
  console.log(`   (If browser doesn't open, visit: ${authUrl.toString()})\n`);
  openBrowser(authUrl.toString());

  console.log('   ⏳ Waiting for authentication...');

  // Wait for callback
  const { code, state: returnedState } = await callbackPromise;

  // Verify state
  if (returnedState !== state) {
    throw new Error('OAuth state mismatch - possible CSRF attack');
  }

  console.log('   ✓ Authorization code received\n');

  // Exchange code for token
  console.log('   🔑 Exchanging code for access token...');
  const tokenResponse = await exchangeCodeForToken(
    metadata.token_endpoint,
    code,
    client.client_id,
    redirectUri,
    codeVerifier
  );

  console.log('   ✓ Access token obtained\n');

  return tokenResponse.access_token;
}

// Fallback to manual token entry
function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(question);
      let input = '';

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (char: string) => {
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            rl.close();
            resolve(input);
            break;
          case '\u0003':
            process.exit(1);
            break;
          case '\u007F':
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);
              process.stdout.write(question + '*'.repeat(input.length));
            }
            break;
          default:
            input += char;
            process.stdout.write('*');
        }
      };

      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function interactiveAuth(mcpBaseUrl: string): Promise<string> {
  try {
    // Try OAuth first
    return await oauthAuthenticate(mcpBaseUrl);
  } catch (error) {
    // Fall back to manual token entry
    console.log(`\n   ⚠️  OAuth authentication failed: ${error instanceof Error ? error.message : error}`);
    console.log('   Falling back to manual token entry...\n');

    console.log('   📋 Instructions:');
    console.log('   1. Go to your Airlock dashboard');
    console.log('   2. Select any project in your organization');
    console.log('   3. Go to the "Connection" tab');
    console.log('   4. Copy the "MCP Access Token"\n');

    const token = await prompt('   Paste your MCP token here: ', true);

    if (!token || token.trim().length === 0) {
      throw new Error('No token provided');
    }

    console.log('\n   ✓ Token received\n');
    return token.trim();
  }
}

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
  npx tsx src/benchmark-live.ts --org <slug>
  npx tsx src/benchmark-live.ts --org <slug> --token <token>

Options:
  --org <slug>   Your Airlock organization slug (required)
  --url <url>         Full MCP endpoint URL (alternative to --org)
  --token <token>     Your MCP access token (will prompt if not provided)
  --env <env>         Environment: production (default), staging, or dev
  --format <format>   Output format: terminal (default) or json
  --help              Show this help message

Examples:
  # Interactive authentication (will open browser)
  npx tsx src/benchmark-live.ts --org my-org

  # With token provided directly
  npx tsx src/benchmark-live.ts --org my-org --token abc123

  # Using staging environment
  npx tsx src/benchmark-live.ts --org my-org --env staging

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
    process.exit(0);
  }

  const env = values.env || 'production';
  let url: string;
  let orgSlug: string;

  if (values.url) {
    url = values.url;
    orgSlug = url.match(/\/org\/([^/?]+)/)?.[1] || 'unknown';
  } else if (values.org) {
    orgSlug = values.org;

    switch (env) {
      case 'production':
        url = `https://mcp.air-lock.ai/org/${orgSlug}`;
        break;
      case 'staging':
        url = `https://mcp.staging.air-lock.ai/org/${orgSlug}`;
        break;
      default:
        // Dev environment - env is the stage name
        url = `https://mcp.${env}.dev.air-lock.ai/org/${orgSlug}`;
    }
  } else {
    console.error('Error: Either --org or --url is required\n');
    printUsage();
    process.exit(1);
  }

  // Get token - either from args or via OAuth
  let token = values.token;

  if (!token) {
    // Get MCP base URL (without the /org/slug part) for OAuth
    const mcpBaseUrl = url.replace(/\/org\/[^/]+$/, '');

    try {
      token = await interactiveAuth(mcpBaseUrl);
    } catch (error) {
      console.error('\n❌ Authentication failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  const format = (values.format as 'terminal' | 'json') || 'terminal';

  try {
    const result = await runLiveBenchmark(url, token);
    printResult(result, format);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
