/**
 * Per-commit token efficiency calculation, mirroring code-review-graph's
 * token_efficiency benchmark (code_review_graph/eval/benchmarks/token_efficiency.py).
 *
 * For each commit we compute three token counts against the same commit:
 *   - naive_tokens    — tokens in the full contents of every changed file
 *   - standard_tokens — tokens in `git diff <sha>~1 <sha>`
 *   - graph_tokens    — tokens in the response an agent would get from
 *                       Airlock Code's `code_review_context` tool
 *
 * code-review-graph approximates tokens as `len(text) // 4`; we use tiktoken
 * (cl100k_base) for consistency with the meta-tools benchmark. Both
 * methodologies return the same ratios within a few percent.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { countTokens } from '../shared/token-counter.js';
import type { RepoFixture, CommitFixture } from './fixtures.js';

export interface CommitTokenResult {
  repo: string;
  commit: string;
  description: string;
  changedFileCount: number;
  naiveTokens: number;
  standardTokens: number;
  graphTokens: number;
  naiveToGraphRatio: number;
  standardToGraphRatio: number;
}

export interface GraphTokenProvider {
  /** Returns the JSON-serialised response an agent would receive. */
  (changedFiles: string[], repoPath: string, sha: string): Promise<string>;
}

/** Where we clone benchmark repos. Kept outside src/ so tsc leaves it alone. */
export const CACHE_DIR = join(process.cwd(), '.cache', 'airlock-code-repos');

/**
 * Ensure the repo is cloned at `CACHE_DIR/<name>` and fetched deeply enough
 * to reach the target SHA. Uses shallow clone + on-demand deepening to keep
 * network usage reasonable while still being able to compute a diff against
 * the commit's parent.
 *
 * If `localRepoPath` is provided, we use it verbatim (no clone, no fetch) —
 * this is the path users hit when they pass `--local-repo ~/projects/foo`
 * for a repo they already have checked out.
 */
export function ensureRepo(repo: RepoFixture, localRepoPath?: string): string {
  if (localRepoPath) {
    if (!existsSync(join(localRepoPath, '.git'))) {
      throw new Error(
        `${localRepoPath} is not a git repository (no .git directory found).`,
      );
    }
    // Still ensure the target commits exist locally — they might be newer
    // than the user's checkout and a `git fetch` brings them in.
    for (const commit of repo.commits) {
      ensureCommitAvailable(localRepoPath, commit.sha);
    }
    return localRepoPath;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, repo.name);

  if (!existsSync(join(path, '.git'))) {
    run(`git clone --filter=blob:none ${repo.url} ${path}`);
  }

  for (const commit of repo.commits) {
    ensureCommitAvailable(path, commit.sha);
  }

  return path;
}

function ensureCommitAvailable(repoPath: string, sha: string): void {
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, {
      cwd: repoPath,
      stdio: 'ignore',
    });
  } catch {
    run(`git fetch --filter=blob:none origin ${sha}`, repoPath);
  }
  // Need the parent for the diff too.
  try {
    execSync(`git cat-file -e ${sha}~1^{commit}`, {
      cwd: repoPath,
      stdio: 'ignore',
    });
  } catch {
    run(`git fetch --filter=blob:none --deepen=1 origin ${sha}`, repoPath);
  }
}

function run(cmd: string, cwd?: string): string {
  // Allow big diffs and `git show` payloads — 256 MB is plenty for repo-sized
  // changes without being reckless. Node's default is 1 MB and that blows up
  // on refactor PRs.
  return execSync(cmd, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * List every file that changed in the commit. Mirrors
 * `git diff --name-only <sha>~1 <sha>` from the reference benchmark.
 */
export function getChangedFiles(repoPath: string, sha: string): string[] {
  const output = run(`git diff --name-only ${sha}~1 ${sha}`, repoPath);
  return output
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Naive baseline: full content of every changed file (tokens), read from
 * the commit via `git show <sha>:<path>` so we never touch the working
 * tree. Files that were deleted in the commit produce zero tokens (git
 * show errors, we swallow it).
 */
export function countNaiveTokens(
  repoPath: string,
  files: string[],
  sha: string,
): number {
  let total = 0;
  for (const f of files) {
    try {
      const content = execSync(`git show ${sha}:${shellQuote(f)}`, {
        cwd: repoPath,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      total += countTokens(content);
    } catch {
      // File doesn't exist at this commit (deleted), is a submodule, or
      // is binary. Either way, skip — matches code-review-graph's tolerant
      // behaviour.
    }
  }
  return total;
}

function shellQuote(s: string): string {
  // Single-quote wrap and escape embedded single quotes. Sufficient for
  // file paths that git can emit — those shouldn't contain nulls or
  // newlines in practice.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Standard baseline: tokens in the unified git diff for the commit. */
export function countStandardTokens(repoPath: string, sha: string): number {
  // -U3 is git's default; left explicit so behaviour is obvious across git versions.
  const diff = run(`git diff -U3 ${sha}~1 ${sha}`, repoPath);
  return countTokens(diff);
}

export async function measureCommit(
  repo: RepoFixture,
  commit: CommitFixture,
  repoPath: string,
  graphTokenProvider: GraphTokenProvider,
): Promise<CommitTokenResult> {
  const changed = getChangedFiles(repoPath, commit.sha);
  if (changed.length === 0) {
    return {
      repo: repo.name,
      commit: commit.sha,
      description: commit.description,
      changedFileCount: 0,
      naiveTokens: 0,
      standardTokens: 0,
      graphTokens: 0,
      naiveToGraphRatio: 0,
      standardToGraphRatio: 0,
    };
  }

  const naiveTokens = countNaiveTokens(repoPath, changed, commit.sha);
  const standardTokens = countStandardTokens(repoPath, commit.sha);
  const responseJson = await graphTokenProvider(changed, repoPath, commit.sha);
  const graphTokens = countTokens(responseJson);

  return {
    repo: repo.name,
    commit: commit.sha,
    description: commit.description,
    changedFileCount: changed.length,
    naiveTokens,
    standardTokens,
    graphTokens,
    naiveToGraphRatio:
      graphTokens > 0 ? round1(naiveTokens / graphTokens) : 0,
    standardToGraphRatio:
      graphTokens > 0 ? round1(standardTokens / graphTokens) : 0,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
