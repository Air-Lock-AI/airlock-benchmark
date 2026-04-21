/**
 * Build dynamic `RepoFixture`s from GitHub PRs or raw commit SHAs.
 *
 * The default benchmark ships with a hard-coded six-repo fixture set for
 * reproducibility. This module is the escape hatch — point it at your own
 * repo (private or public) and a list of PR numbers / SHAs, and it returns
 * a `RepoFixture` the existing benchmark pipeline can consume.
 *
 * GitHub access goes through the `gh` CLI rather than raw REST so private
 * repos work out of the box (reusing whatever auth the user already has
 * configured). Every helper here is synchronous-shaped via `execSync`
 * because the volume is low (O(PRs)) and it keeps error handling readable.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { RepoFixture, CommitFixture } from './fixtures.js';

export interface BuildFixtureOptions {
  /** `owner/name` — used to drive gh + infer the clone URL. */
  repo: string;
  /** Comma-separated PR numbers to include (merge commits are used). */
  prs?: number[];
  /** Include the last N merged PRs in the repo. */
  last?: number;
  /** Raw commit SHAs to include alongside any PRs. */
  shas?: string[];
  /** Use an already-checked-out clone instead of cloning into the cache. */
  localRepoPath?: string;
}

interface PrGhResponse {
  number: number;
  title: string;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
}

/**
 * Run `gh` with JSON output. Throws with a helpful message if gh isn't
 * installed or the user isn't authenticated for a private repo.
 */
function gh<T>(args: string[]): T {
  let output: string;
  try {
    output = execSync(`gh ${args.join(' ')}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh command failed: ${message}\n` +
        `Check that (1) the GitHub CLI is installed, (2) you are authenticated ` +
        `with \`gh auth status\`, and (3) the token has access to the repo.`,
    );
  }
  return JSON.parse(output) as T;
}

function resolvePr(repo: string, num: number): CommitFixture {
  const pr = gh<PrGhResponse>([
    'pr',
    'view',
    String(num),
    '-R',
    repo,
    '--json',
    'number,title,mergeCommit,headRefOid',
  ]);

  const sha = pr.mergeCommit?.oid ?? pr.headRefOid;
  if (!sha) {
    throw new Error(`PR #${num} in ${repo} has no merge commit or head SHA.`);
  }

  return {
    sha,
    description: `#${pr.number}: ${pr.title}`,
    expectedChangedFiles: 0,
  };
}

function resolveLastMerged(repo: string, n: number): CommitFixture[] {
  const list = gh<PrGhResponse[]>([
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'merged',
    '--limit',
    String(n),
    '--json',
    'number,title,mergeCommit,headRefOid',
  ]);

  return list
    .map((pr) => {
      const sha = pr.mergeCommit?.oid ?? pr.headRefOid;
      if (!sha) return null;
      return {
        sha,
        description: `#${pr.number}: ${pr.title}`,
        expectedChangedFiles: 0,
      } satisfies CommitFixture;
    })
    .filter((c): c is CommitFixture => c !== null);
}

function inferLanguage(repo: string): string {
  // Cheap fallback — the benchmark doesn't actually use the language field
  // beyond the fixture metadata, so a single gh call to fetch it per run
  // is overkill.
  void repo;
  return 'unknown';
}

function cloneUrlFor(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function validateRepo(repo: string): void {
  // GitHub owner/repo names allow ASCII alphanumerics, dots, underscores,
  // and hyphens — nothing else. Tighter than GitHub's own rules on
  // purpose, because `repo` is spliced into `git clone` via execSync,
  // which invokes /bin/sh. A permissive regex (e.g. `[^/\s]+`) would let
  // `;`, `$`, backticks, and quote characters through into the shell.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
    throw new Error(
      `--repo must be in \`owner/name\` form using only [A-Za-z0-9._-] ` +
        `(got: \`${repo}\`).`,
    );
  }
}

function validateSha(sha: string): void {
  // Accept 7–64 hex chars — covers short abbreviations and SHA-256 if
  // GitHub ever switches. Same rationale as validateRepo: SHAs are
  // spliced into `git show` / `git diff` via execSync.
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) {
    throw new Error(
      `--sha values must be hex commit SHAs (got: \`${sha}\`).`,
    );
  }
}

export function buildDynamicFixture(opts: BuildFixtureOptions): RepoFixture {
  validateRepo(opts.repo);
  const [, name] = opts.repo.split('/');

  const commits: CommitFixture[] = [];
  if (opts.prs && opts.prs.length > 0) {
    for (const num of opts.prs) commits.push(resolvePr(opts.repo, num));
  }
  if (opts.last && opts.last > 0) {
    commits.push(...resolveLastMerged(opts.repo, opts.last));
  }
  if (opts.shas) {
    for (const sha of opts.shas) {
      validateSha(sha);
      commits.push({
        sha,
        description: `sha ${sha.slice(0, 10)}`,
        expectedChangedFiles: 0,
      });
    }
  }

  if (commits.length === 0) {
    throw new Error(
      'No commits to benchmark. Pass at least one of --pr, --last, or --sha.',
    );
  }

  if (opts.localRepoPath && !existsSync(opts.localRepoPath)) {
    throw new Error(
      `--local-repo path does not exist: ${opts.localRepoPath}`,
    );
  }

  return {
    name: name.toLowerCase(),
    url: cloneUrlFor(opts.repo),
    language: inferLanguage(opts.repo),
    sizeCategory: 'small',
    commits,
  };
}

/**
 * Parse CLI values into `BuildFixtureOptions`. Returns `null` when the user
 * passed no PR-mode flags, so callers fall back to the default fixture set.
 */
export function parsePrModeFlags(values: {
  repo?: string;
  pr?: string;
  last?: string;
  sha?: string;
  'local-repo'?: string;
}): BuildFixtureOptions | null {
  if (!values.repo && !values.pr && !values.last && !values.sha) {
    return null;
  }
  if (!values.repo) {
    throw new Error('--repo is required when using --pr / --last / --sha.');
  }
  const prs = values.pr
    ?.split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  const shas = values.sha?.split(',').map((s) => s.trim()).filter(Boolean);
  const last = values.last ? Number.parseInt(values.last, 10) : undefined;
  return {
    repo: values.repo,
    prs: prs && prs.length > 0 ? prs : undefined,
    last: last && !Number.isNaN(last) ? last : undefined,
    shas: shas && shas.length > 0 ? shas : undefined,
    localRepoPath: values['local-repo'],
  };
}
