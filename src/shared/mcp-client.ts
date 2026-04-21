/**
 * Minimal MCP (Model Context Protocol) JSON-RPC client used by both live
 * benchmarks. Talks HTTP + JSON-RPC 2.0 to an Airlock MCP endpoint.
 *
 * Deliberately small — no streaming, no notifications, no server-sent
 * events. All we need is `initialize` + `tools/list` + `tools/call`, which
 * is enough to measure response sizes.
 */

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

export interface MCPToolListResult {
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

export interface MCPToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class MCPClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private requestId = 0;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
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
      throw new Error(
        `MCP request failed: ${response.status} ${response.statusText}\n${text}`,
      );
    }

    const data = (await response.json()) as MCPResponse;
    if (data.error) {
      throw new Error(
        `MCP error: ${data.error.message} (code: ${data.error.code})`,
      );
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

  async listTools(): Promise<MCPToolListResult> {
    return this.request<MCPToolListResult>('tools/list');
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolCallResult> {
    return this.request<MCPToolCallResult>('tools/call', {
      name,
      arguments: args,
    });
  }

  /** Returns the raw response text that would be seen by an agent. */
  async callToolText(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.callTool(name, args);
    return result.content?.[0]?.text ?? '';
  }
}
