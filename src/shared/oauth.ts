/**
 * OAuth + manual-token authentication helpers for the Airlock MCP endpoint.
 *
 * Shared by both the meta-tools live benchmark and the Airlock Code live
 * benchmark so the flow stays consistent (and so fixing a bug in one fixes
 * it in the other).
 *
 * Mechanics:
 *   1. Discover OAuth metadata from /.well-known/oauth-authorization-server
 *   2. Dynamically register a throwaway public client for this CLI run
 *   3. Drive an authorization-code + PKCE flow through a local callback
 *      server on 127.0.0.1
 *   4. Exchange the code for an access token
 *   5. Fall back to manual token paste if any of that breaks (firewall,
 *      captive portal, dynamic registration disabled, …)
 */

import { createInterface } from 'readline';
import { exec } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { join } from 'path';

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

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  // /proc signature — present even on WSL setups that don't export the env vars.
  return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}

function resolveBrowserCommand(url: string): string {
  // Explicit `BROWSER=…` always wins — standard xdg convention, and the
  // same escape hatch Claude Code docs tell WSL users to set.
  if (process.env.BROWSER) {
    return `${process.env.BROWSER} "${url}"`;
  }
  switch (process.platform) {
    case 'darwin':
      return `open "${url}"`;
    case 'win32':
      return `start "" "${url}"`;
    default:
      if (isWSL()) {
        // Hand the URL to Windows' shell so the user's default Windows
        // browser opens. The leading empty "" is `start`'s title argument —
        // otherwise `start` interprets the first quoted arg as the title.
        return `cmd.exe /c start "" "${url}"`;
      }
      return `xdg-open "${url}"`;
  }
}

function openBrowser(url: string): void {
  const command = resolveBrowserCommand(url);
  exec(command, (error) => {
    if (error) {
      console.log(`\n   Could not open browser automatically.`);
      console.log(`   Please open this URL manually: ${url}`);
      console.log(
        `   (Tip: on WSL set BROWSER=/mnt/c/Program\\ Files/Google/Chrome/Application/chrome.exe ` +
          `— or any other Windows browser path — to bypass the cmd.exe handoff.)\n`,
      );
    }
  });
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
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
  redirectUri: string,
): Promise<OAuthClientRegistration> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Airlock Benchmark CLI',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
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
  codeVerifier: string,
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
          res.end(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authentication Failed</title></head>` +
              `<body style="font-family: sans-serif; text-align: center; padding: 50px;">` +
              `<h1 style="color: #dc3545;">Authentication Failed</h1>` +
              `<p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
          );
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (code && state) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authentication Successful</title></head>` +
              `<body style="font-family: sans-serif; text-align: center; padding: 50px;">` +
              `<h1 style="color: #28a745;">Authentication Successful</h1>` +
              `<p>You can close this window and return to the terminal.</p>` +
              `<script>window.close();</script></body></html>`,
          );
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
    server.listen(port, '127.0.0.1');
    server.on('error', (err) => reject(err));
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out'));
    }, 5 * 60 * 1000);
  });
}

async function oauthAuthenticateWithMeta(
  mcpBaseUrl: string,
): Promise<{ token: string; expiresIn: number }> {
  const token = await oauthAuthenticate(mcpBaseUrl);
  return { token, expiresIn: lastTokenExpiresIn ?? 3600 };
}

// Captured by oauthAuthenticate on the most recent token exchange so the
// caller can persist the expiry alongside the token. Keeping it module-
// level avoids threading a second return value through the existing API.
let lastTokenExpiresIn: number | undefined;

async function oauthAuthenticate(mcpBaseUrl: string): Promise<string> {
  console.log('\n🔐 OAuth Authentication\n');
  const port = 9876 + Math.floor(Math.random() * 100);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  console.log('   📡 Fetching OAuth configuration...');
  const metadata = await fetchOAuthMetadata(mcpBaseUrl);
  console.log('   ✓ OAuth server found\n');

  if (!metadata.registration_endpoint) {
    throw new Error('OAuth server does not support dynamic client registration');
  }

  console.log('   📝 Registering CLI client...');
  const client = await registerClient(metadata.registration_endpoint, redirectUri);
  console.log('   ✓ Client registered\n');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const callbackPromise = startCallbackServer(port);

  console.log('   🌐 Opening browser for authentication...');
  console.log(`   (If browser doesn't open, visit: ${authUrl.toString()})\n`);
  openBrowser(authUrl.toString());

  console.log('   ⏳ Waiting for authentication...');
  const { code, state: returnedState } = await callbackPromise;
  if (returnedState !== state) {
    throw new Error('OAuth state mismatch - possible CSRF attack');
  }
  console.log('   ✓ Authorization code received\n');

  console.log('   🔑 Exchanging code for access token...');
  const tokenResponse = await exchangeCodeForToken(
    metadata.token_endpoint,
    code,
    client.client_id,
    redirectUri,
    codeVerifier,
  );
  console.log('   ✓ Access token obtained\n');
  lastTokenExpiresIn = tokenResponse.expires_in;
  return tokenResponse.access_token;
}

function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

interface CachedToken {
  token: string;
  expiresAt: number; // unix seconds
  host: string;
}

const TOKEN_CACHE_DIR = join(process.cwd(), '.cache');

function tokenCachePath(mcpBaseUrl: string): string {
  const host = new URL(mcpBaseUrl).host.replace(/[^a-z0-9._-]/gi, '_');
  return join(TOKEN_CACHE_DIR, `airlock-token-${host}.json`);
}

function loadCachedToken(mcpBaseUrl: string): string | null {
  const path = tokenCachePath(mcpBaseUrl);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CachedToken;
    // 30 s grace so we don't hand back a token that's about to die mid-run.
    if (parsed.expiresAt > Math.floor(Date.now() / 1000) + 30) {
      return parsed.token;
    }
  } catch {
    // Corrupt cache — fall through and re-auth.
  }
  return null;
}

function saveCachedToken(mcpBaseUrl: string, token: string, expiresIn = 3600): void {
  try {
    mkdirSync(TOKEN_CACHE_DIR, { recursive: true });
    const payload: CachedToken = {
      token,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      host: new URL(mcpBaseUrl).host,
    };
    // 0600 so the token isn't world-readable in shared dev boxes.
    writeFileSync(tokenCachePath(mcpBaseUrl), JSON.stringify(payload), {
      mode: 0o600,
    });
  } catch {
    // Cache is nice-to-have — never block the main flow.
  }
}

/**
 * Try OAuth; if it fails, fall back to a manual-paste prompt for an MCP
 * access token. Returns the bearer token to use for subsequent requests.
 *
 * Tokens are cached at `.cache/airlock-token-<host>.json` for the lifetime
 * the OAuth server told us, so back-to-back benchmark runs don't re-open
 * the browser each time. The cache is git-ignored.
 */
export async function interactiveAuth(mcpBaseUrl: string): Promise<string> {
  const cached = loadCachedToken(mcpBaseUrl);
  if (cached) {
    console.log('🔐 Reusing cached access token (still valid).\n');
    return cached;
  }

  try {
    const { token, expiresIn } = await oauthAuthenticateWithMeta(mcpBaseUrl);
    saveCachedToken(mcpBaseUrl, token, expiresIn);
    return token;
  } catch (error) {
    console.log(
      `\n   ⚠️  OAuth authentication failed: ${error instanceof Error ? error.message : error}`,
    );
    console.log('   Falling back to manual token entry...\n');
    console.log('   📋 Instructions:');
    console.log('   1. Go to your Airlock dashboard');
    console.log('   2. Select any project in your organization');
    console.log('   3. Go to the "Connection" tab');
    console.log('   4. Copy the "MCP Access Token"\n');
    const token = await promptLine('   Paste your MCP token here: ');
    if (!token || token.trim().length === 0) {
      throw new Error('No token provided');
    }
    console.log('\n   ✓ Token received\n');
    saveCachedToken(mcpBaseUrl, token.trim());
    return token.trim();
  }
}

/**
 * Resolve an Airlock org slug + environment into a full MCP URL, matching
 * the pattern the existing benchmark-live.ts used.
 */
export function resolveAirlockUrl(
  org: string,
  env: 'production' | 'staging' | string = 'production',
): string {
  switch (env) {
    case 'production':
      return `https://mcp.air-lock.ai/org/${org}`;
    case 'staging':
      return `https://mcp.staging.air-lock.ai/org/${org}`;
    default:
      return `https://mcp.${env}.dev.air-lock.ai/org/${org}`;
  }
}
