/**
 * Simulated response for Airlock Code's `code_review_context` tool.
 *
 * The real tool runs this SQL against a DuckDB view of the knowledge graph
 * (see packages/functions/shared/airlock-code-handlers.ts::buildReviewContext
 * in the airlock repo):
 *
 *   SELECT category, name, entity_type FROM (
 *     changed_file rows  UNION ALL
 *     contained_symbol rows  UNION ALL
 *     impacted_file rows  UNION ALL
 *     covering_test rows
 *   ) LIMIT 200
 *
 * We model the response shape exactly (a `{rows, count, truncated}` envelope
 * matching Airlock's MCP response layer), and estimate per-category row
 * counts from the actual source files in the commit. This keeps the
 * simulation grounded in real content rather than hand-tuned numbers — you
 * can always flip to `benchmark-live.ts` to replace these estimates with
 * measurements from a real Airlock Code instance.
 *
 * Simulation heuristics:
 *
 *   contained_symbol rows : count of `function|class|def|func ` declarations
 *                           in the file (regex on file content), capped per
 *                           file so one megafile doesn't blow the cap
 *   impacted_file rows    : min(2 * contained_symbol count, 50) — typical
 *                           fan-out for a medium-sized PR. Consistent with
 *                           the SQL's reachability via CALLS / IMPORTS_FROM
 *                           edges.
 *   covering_test rows    : min(contained_symbol count, 30) — most changed
 *                           functions have 0-1 covering tests; we stay on
 *                           the generous side so the graph number is not
 *                           artificially low.
 *
 * Total rows are capped at 200 to match the SQL's LIMIT.
 */

import { execSync } from 'child_process';
import { basename, extname } from 'path';
import type { GraphTokenProvider } from './token-efficiency.js';

const SYMBOL_REGEX = new RegExp(
  [
    '^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+([A-Za-z_][A-Za-z0-9_]*)', // JS / TS
    '^\\s*(?:export\\s+)?class\\s+([A-Za-z_][A-Za-z0-9_]*)', // JS / TS / Python
    '^\\s*def\\s+([A-Za-z_][A-Za-z0-9_]*)', // Python
    '^\\s*func\\s+(?:\\([^)]*\\)\\s+)?([A-Za-z_][A-Za-z0-9_]*)', // Go
    '^\\s*(?:export\\s+)?(?:pub\\s+)?fn\\s+([A-Za-z_][A-Za-z0-9_]*)', // Rust
  ].join('|'),
  'gm',
);

const TEXT_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.scala',
  '.cs',
]);

const PER_FILE_SYMBOL_CAP = 40;
const TOTAL_ROW_CAP = 200;
const TYPES_FROM_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
};

interface ReviewContextRow {
  category: 'changed_file' | 'contained_symbol' | 'impacted_file' | 'covering_test';
  name: string;
  entity_type: 'CodeFile' | 'CodeFunction' | 'CodeClass' | 'CodeTest';
  repository?: string;
  confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  confidence_score?: number;
}

interface ReviewContextResponse {
  rows: ReviewContextRow[];
  count: number;
  truncated: boolean;
}

function countSymbolsInFile(
  repoPath: string,
  sha: string,
  file: string,
): string[] {
  if (!TEXT_EXTS.has(extname(file).toLowerCase())) return [];

  let content: string;
  try {
    content = execSync(`git show ${sha}:${shellQuote(file)}`, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const names: string[] = [];
  SYMBOL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SYMBOL_REGEX.exec(content)) !== null) {
    const name = match.slice(1).find((g) => Boolean(g));
    if (name) names.push(name);
    if (names.length >= PER_FILE_SYMBOL_CAP) break;
  }
  return names;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function entityTypeForExt(ext: string): 'CodeFile' {
  // We keep this a function so it's easy to extend if we ever want
  // language-specific file-kind rows; today every file row is CodeFile.
  void ext;
  return 'CodeFile';
}

function languageFor(file: string): string {
  return TYPES_FROM_EXT[extname(file).toLowerCase()] ?? 'Unknown';
}

export function buildSimulatedReviewContext(
  changedFiles: string[],
  repoPath: string,
  sha: string,
  repoSlug = 'benchmark/repo',
): ReviewContextResponse {
  const rows: ReviewContextRow[] = [];
  const allSymbols: Array<{ file: string; name: string }> = [];

  for (const rel of changedFiles) {
    rows.push({
      category: 'changed_file',
      name: rel,
      entity_type: entityTypeForExt(extname(rel)),
      repository: repoSlug,
      confidence: 'EXTRACTED',
      confidence_score: 1.0,
    });
  }

  for (const rel of changedFiles) {
    const symbols = countSymbolsInFile(repoPath, sha, rel);
    for (const sym of symbols) {
      allSymbols.push({ file: rel, name: sym });
    }
  }

  for (const { file, name } of allSymbols) {
    rows.push({
      category: 'contained_symbol',
      name: `${file}::${name}`,
      entity_type: 'CodeFunction',
      repository: repoSlug,
      confidence: 'EXTRACTED',
      confidence_score: 1.0,
    });
    if (rows.length >= TOTAL_ROW_CAP) break;
  }

  const impactedCount = Math.min(
    Math.max(allSymbols.length * 2, changedFiles.length),
    50,
  );
  for (let i = 0; i < impactedCount && rows.length < TOTAL_ROW_CAP; i++) {
    const seed = allSymbols[i % Math.max(allSymbols.length, 1)] ?? {
      file: changedFiles[i % changedFiles.length] ?? 'unknown',
      name: 'caller',
    };
    rows.push({
      category: 'impacted_file',
      name: `impacted/${basename(seed.file, extname(seed.file))}_caller_${i}${extname(seed.file)}`,
      entity_type: 'CodeFile',
      repository: repoSlug,
      confidence: i % 5 === 0 ? 'INFERRED' : 'EXTRACTED',
      confidence_score: i % 5 === 0 ? 0.8 : 1.0,
    });
  }

  const testCount = Math.min(allSymbols.length, 30);
  for (let i = 0; i < testCount && rows.length < TOTAL_ROW_CAP; i++) {
    const sym = allSymbols[i];
    rows.push({
      category: 'covering_test',
      name: `test/test_${sym.name}.${languageFor(sym.file) === 'Python' ? 'py' : 'ts'}::test_${sym.name}`,
      entity_type: 'CodeTest',
      repository: repoSlug,
      confidence: 'AMBIGUOUS',
      confidence_score: 0.4,
    });
  }

  const truncated = rows.length >= TOTAL_ROW_CAP;
  return {
    rows: rows.slice(0, TOTAL_ROW_CAP),
    count: Math.min(rows.length, TOTAL_ROW_CAP),
    truncated,
  };
}

/**
 * GraphTokenProvider that serialises the simulated response the same way
 * Airlock's MCP layer does — compact JSON, no pretty-printing — so the
 * token count reflects what an agent would actually receive.
 */
export const simulatedGraphTokenProvider: GraphTokenProvider = async (
  changedFiles,
  repoPath,
  sha,
) => {
  const response = buildSimulatedReviewContext(changedFiles, repoPath, sha);
  return JSON.stringify(response);
};
