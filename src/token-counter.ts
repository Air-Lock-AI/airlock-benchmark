/**
 * Token counting utilities using tiktoken for accurate counts.
 * Uses cl100k_base encoding (used by GPT-4, Claude, etc.)
 */

import { get_encoding, type Tiktoken } from 'tiktoken';

let encoder: Tiktoken | null = null;

/**
 * Get or initialize the tiktoken encoder.
 * Uses cl100k_base which is the encoding for GPT-4 and similar models.
 */
function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = get_encoding('cl100k_base');
  }
  return encoder;
}

/**
 * Count tokens in a string using tiktoken.
 */
export function countTokens(text: string): number {
  const enc = getEncoder();
  return enc.encode(text).length;
}

/**
 * Count tokens for an MCP tool definition.
 */
export function countToolTokens(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): number {
  const toolJson = JSON.stringify(tool, null, 2);
  return countTokens(toolJson);
}

/**
 * Free the encoder resources when done.
 * Call this at the end of your program if needed.
 */
export function freeEncoder(): void {
  if (encoder) {
    encoder.free();
    encoder = null;
  }
}
