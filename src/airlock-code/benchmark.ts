#!/usr/bin/env node
/**
 * Airlock Code Token Savings Benchmark (simulated)
 *
 * Measures how many tokens an agent saves by calling Airlock Code's
 * `code_review_context` tool instead of reading changed files directly or
 * feeding a raw git diff.
 *
 * Methodology mirrors code-review-graph's token_efficiency benchmark
 * (https://github.com/tirth8205/code-review-graph) so the two projects'
 * published ratios line up row for row.
 *
 *   naive_tokens    = sum(tiktoken(file_content)) for every changed file
 *   standard_tokens = tiktoken(git diff <sha>~1 <sha>)
 *   graph_tokens    = tiktoken(JSON.stringify(code_review_context response))
 *
 * The `graph_tokens` column here is simulated: we generate a response that
 * matches the exact shape Airlock's SQL returns, sized from the real file
 * content in the commit. Run `benchmark-live.ts` to replace the simulation
 * with measurements against a real Airlock Code instance.
 *
 * Run with: npm run benchmark:code
 */

import { parseArgs } from 'util';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { freeEncoder } from '../shared/token-counter.js';
import { REPO_FIXTURES, type RepoFixture } from './fixtures.js';
import { ensureRepo, measureCommit, type CommitTokenResult } from './token-efficiency.js';
import { simulatedGraphTokenProvider } from './simulate-response.js';
import { buildDynamicFixture, parsePrModeFlags, type BuildFixtureOptions } from './pr-fixtures.js';

const COST_PER_MILLION_TOKENS = 3.0;
const MONTHLY_REQUESTS_PER_USER = 1000;

interface RunOptions {
  only?: string;
  dynamicFixture?: { fixture: RepoFixture; opts: BuildFixtureOptions };
}

async function run(options: RunOptions = {}): Promise<CommitTokenResult[]> {
  const results: CommitTokenResult[] = [];

  let fixtures: RepoFixture[];
  let localRepoPath: string | undefined;
  if (options.dynamicFixture) {
    fixtures = [options.dynamicFixture.fixture];
    localRepoPath = options.dynamicFixture.opts.localRepoPath;
  } else if (options.only) {
    fixtures = REPO_FIXTURES.filter((r) => r.name === options.only);
    if (fixtures.length === 0) {
      throw new Error(
        `No fixture named '${options.only}'. Available: ${REPO_FIXTURES.map((r) => r.name).join(', ')}`,
      );
    }
  } else {
    fixtures = REPO_FIXTURES;
  }

  for (const repo of fixtures) {
    console.error(`   • ${repo.name}: ${localRepoPath ? 'using local clone' : 'cloning / fetching'}…`);
    const path = ensureRepo(repo, localRepoPath);
    for (const commit of repo.commits) {
      const result = await measureCommit(
        repo,
        commit,
        path,
        simulatedGraphTokenProvider,
      );
      results.push(result);
      console.error(
        `     ✓ ${commit.sha.slice(0, 7)}  ${commit.description.slice(0, 50)}`,
      );
      console.error(
        `        files=${result.changedFileCount}  naive=${result.naiveTokens}  ` +
          `std=${result.standardTokens}  graph=${result.graphTokens}  ` +
          `ratio=${result.naiveToGraphRatio}x`,
      );
    }
  }
  return results;
}

interface RepoAggregate {
  repo: string;
  commits: number;
  avgNaive: number;
  avgStandard: number;
  avgGraph: number;
  avgNaiveRatio: number;
  avgStandardRatio: number;
}

function aggregateByRepo(results: CommitTokenResult[]): RepoAggregate[] {
  const grouped = new Map<string, CommitTokenResult[]>();
  for (const r of results) {
    const arr = grouped.get(r.repo) ?? [];
    arr.push(r);
    grouped.set(r.repo, arr);
  }
  const out: RepoAggregate[] = [];
  for (const [repo, rows] of grouped) {
    const n = rows.length;
    out.push({
      repo,
      commits: n,
      avgNaive: Math.round(rows.reduce((s, r) => s + r.naiveTokens, 0) / n),
      avgStandard: Math.round(
        rows.reduce((s, r) => s + r.standardTokens, 0) / n,
      ),
      avgGraph: Math.round(rows.reduce((s, r) => s + r.graphTokens, 0) / n),
      avgNaiveRatio: round1(
        rows.reduce((s, r) => s + r.naiveToGraphRatio, 0) / n,
      ),
      avgStandardRatio: round1(
        rows.reduce((s, r) => s + r.standardToGraphRatio, 0) / n,
      ),
    });
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function formatMoney(dollars: number): string {
  if (dollars >= 1000) return '$' + (dollars / 1000).toFixed(1) + 'k';
  if (dollars >= 10) return '$' + dollars.toFixed(0);
  if (dollars >= 1) return '$' + dollars.toFixed(2);
  return '$' + dollars.toFixed(3);
}

function printTerminal(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
): void {
  console.log('\n' + '='.repeat(110));
  console.log('AIRLOCK CODE TOKEN SAVINGS BENCHMARK  (simulated)');
  console.log('='.repeat(110));

  console.log('\n📋 Per-commit results:');
  console.log(
    '| Repo'.padEnd(12) +
      '| Commit '.padEnd(10) +
      '| Files'.padEnd(8) +
      '| Naive'.padEnd(10) +
      '| Standard'.padEnd(12) +
      '| Graph'.padEnd(10) +
      '| N/G'.padEnd(8) +
      '| S/G'.padEnd(8) +
      '|',
  );
  console.log('|' + '-'.repeat(108) + '|');
  for (const r of results) {
    console.log(
      '| ' +
        r.repo.padEnd(10) +
        '| ' +
        r.commit.slice(0, 7).padEnd(8) +
        '| ' +
        r.changedFileCount.toString().padEnd(6) +
        '| ' +
        r.naiveTokens.toLocaleString().padEnd(8) +
        '| ' +
        r.standardTokens.toLocaleString().padEnd(10) +
        '| ' +
        r.graphTokens.toLocaleString().padEnd(8) +
        '| ' +
        (r.naiveToGraphRatio + 'x').padEnd(6) +
        '| ' +
        (r.standardToGraphRatio + 'x').padEnd(6) +
        '|',
    );
  }

  console.log('\n📊 Per-repo averages:');
  console.log(
    '| Repo'.padEnd(12) +
      '| Commits'.padEnd(10) +
      '| Naive'.padEnd(10) +
      '| Standard'.padEnd(12) +
      '| Graph'.padEnd(10) +
      '| N/G'.padEnd(8) +
      '| S/G'.padEnd(8) +
      '|',
  );
  console.log('|' + '-'.repeat(68) + '|');
  for (const a of aggregates) {
    console.log(
      '| ' +
        a.repo.padEnd(10) +
        '| ' +
        a.commits.toString().padEnd(8) +
        '| ' +
        a.avgNaive.toLocaleString().padEnd(8) +
        '| ' +
        a.avgStandard.toLocaleString().padEnd(10) +
        '| ' +
        a.avgGraph.toLocaleString().padEnd(8) +
        '| ' +
        (a.avgNaiveRatio + 'x').padEnd(6) +
        '| ' +
        (a.avgStandardRatio + 'x').padEnd(6) +
        '|',
    );
  }

  const totalNaive = results.reduce((s, r) => s + r.naiveTokens, 0);
  const totalGraph = results.reduce((s, r) => s + r.graphTokens, 0);
  const overallRatio = totalGraph > 0 ? totalNaive / totalGraph : 0;
  const savedPerCommit =
    (totalNaive - totalGraph) /
    Math.max(results.length, 1);
  const savedPerCommitUsd =
    (savedPerCommit / 1_000_000) * COST_PER_MILLION_TOKENS;
  const monthlySavings = savedPerCommitUsd * MONTHLY_REQUESTS_PER_USER;

  console.log('\n' + '='.repeat(110));
  console.log('SUMMARY');
  console.log('='.repeat(110));
  console.log(
    `  Overall naive-vs-graph reduction: ${round1(overallRatio)}x`,
  );
  console.log(
    `  Avg tokens saved per review:      ${Math.round(savedPerCommit).toLocaleString()} ` +
      `(${formatMoney(savedPerCommitUsd)} / request)`,
  );
  console.log(
    `  At ${MONTHLY_REQUESTS_PER_USER.toLocaleString()} reviews/user/month: ${formatMoney(monthlySavings)} / user / month`,
  );
  console.log(
    '\n  Methodology matches code-review-graph.com so numbers compare row-for-row.',
  );
  console.log(
    '  Run `npm run benchmark:code:live` to replace simulation with live Airlock Code measurements.',
  );
}

function printJson(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
): void {
  console.log(
    JSON.stringify(
      {
        benchmark: 'airlock-code-token-efficiency',
        mode: 'simulated',
        generatedAt: new Date().toISOString(),
        perCommit: results,
        perRepo: aggregates,
      },
      null,
      2,
    ),
  );
}

function printMarkdown(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
): void {
  console.log('# Airlock Code Token Savings Benchmark (simulated)\n');
  console.log(
    'Methodology mirrors [code-review-graph](https://github.com/tirth8205/code-review-graph) ' +
      'so per-repo ratios line up row for row.\n',
  );

  console.log('## Per-repo averages\n');
  console.log(
    '| Repo | Commits | Avg Naive Tokens | Avg Standard Tokens | Avg Graph Tokens | Naive/Graph | Std/Graph |',
  );
  console.log('|------|--------:|-----------------:|--------------------:|-----------------:|------------:|----------:|');
  for (const a of aggregates) {
    console.log(
      `| ${a.repo} | ${a.commits} | ${a.avgNaive.toLocaleString()} | ` +
        `${a.avgStandard.toLocaleString()} | ${a.avgGraph.toLocaleString()} | ` +
        `${a.avgNaiveRatio}x | ${a.avgStandardRatio}x |`,
    );
  }

  console.log('\n## Per-commit detail\n');
  console.log(
    '| Repo | Commit | Files | Naive | Standard | Graph | Naive/Graph | Std/Graph |',
  );
  console.log('|------|--------|------:|------:|---------:|------:|------------:|----------:|');
  for (const r of results) {
    console.log(
      `| ${r.repo} | \`${r.commit.slice(0, 10)}\` | ${r.changedFileCount} | ` +
        `${r.naiveTokens.toLocaleString()} | ${r.standardTokens.toLocaleString()} | ` +
        `${r.graphTokens.toLocaleString()} | ${r.naiveToGraphRatio}x | ` +
        `${r.standardToGraphRatio}x |`,
    );
  }
}

function writeReport(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
  outDir: string,
): string {
  mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  lines.push('# Airlock Code — Token Efficiency (simulated)');
  lines.push('');
  lines.push(
    'Mirrors [code-review-graph](https://github.com/tirth8205/code-review-graph) ' +
      "token_efficiency benchmark so Airlock Code's numbers line up with theirs.",
  );
  lines.push('');
  lines.push(
    '`naive_tokens = sum(file_content)`, ' +
      '`standard_tokens = git diff -U3 <sha>~1 <sha>`, ' +
      '`graph_tokens = JSON.stringify(code_review_context response)`. ' +
      'All three counts use tiktoken cl100k_base.',
  );
  lines.push('');
  lines.push('## Per-repo averages\n');
  lines.push(
    '| Repo | Commits | Avg Naive Tokens | Avg Graph Tokens | Reduction |',
  );
  lines.push('|------|--------:|-----------------:|-----------------:|----------:|');
  for (const a of aggregates) {
    lines.push(
      `| ${a.repo} | ${a.commits} | ${a.avgNaive.toLocaleString()} | ` +
        `${a.avgGraph.toLocaleString()} | ${a.avgNaiveRatio}x |`,
    );
  }
  lines.push('');
  lines.push('## Per-commit results\n');
  lines.push(
    '| Repo | Commit | Files | Naive | Standard | Graph | Naive/Graph | Std/Graph |',
  );
  lines.push('|------|--------|------:|------:|---------:|------:|------------:|----------:|');
  for (const r of results) {
    lines.push(
      `| ${r.repo} | \`${r.commit.slice(0, 10)}\` | ${r.changedFileCount} | ` +
        `${r.naiveTokens.toLocaleString()} | ${r.standardTokens.toLocaleString()} | ` +
        `${r.graphTokens.toLocaleString()} | ${r.naiveToGraphRatio}x | ` +
        `${r.standardToGraphRatio}x |`,
    );
  }

  const outPath = join(outDir, 'summary.md');
  writeFileSync(outPath, lines.join('\n') + '\n');
  return outPath;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      format: { type: 'string', default: 'terminal' },
      only: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      last: { type: 'string' },
      sha: { type: 'string' },
      'local-repo': { type: 'string' },
      report: { type: 'boolean', default: false },
      'report-dir': {
        type: 'string',
        default: join(process.cwd(), 'evaluate', 'reports'),
      },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(`
Airlock Code Token Savings Benchmark (simulated)

Usage:
  npm run benchmark:code                            # default fixture set
  npm run benchmark:code -- --only httpx            # single fixture repo
  npm run benchmark:code -- --format json
  npm run benchmark:code -- --report                # write evaluate/reports/summary.md

Your-own-PRs mode:
  npm run benchmark:code -- --repo Air-Lock-AI/airlock --last 20
  npm run benchmark:code -- --repo Air-Lock-AI/airlock --pr 1105,1104,1103
  npm run benchmark:code -- --repo Air-Lock-AI/airlock --last 20 --local-repo ~/projects/airlock

Options:
  --format <terminal|json|markdown>  Output format (default: terminal)
  --only <repo>                      Run against a single default fixture
  --repo <owner/name>                Target repo (enables your-own-PRs mode)
  --pr <nums>                        Comma-separated PR numbers (merge commits)
  --last <n>                         Include the last N merged PRs
  --sha <shas>                       Raw commit SHAs (comma-separated)
  --local-repo <path>                Use an existing local clone instead of cloning
  --report                           Also write summary.md alongside the run
  --report-dir <path>                Directory for summary.md (default: evaluate/reports)

Private repos work if you are authenticated with \`gh auth login\`.
`);
    return;
  }

  if (values.format === 'terminal') {
    console.error('\n🔬 Measuring token efficiency…\n');
  }

  const prOpts = parsePrModeFlags(values as never);
  const dynamicFixture = prOpts
    ? { fixture: buildDynamicFixture(prOpts), opts: prOpts }
    : undefined;

  try {
    const results = await run({
      only: values.only as string | undefined,
      dynamicFixture,
    });
    const aggregates = aggregateByRepo(results);

    if (values.format === 'json') {
      printJson(results, aggregates);
    } else if (values.format === 'markdown') {
      printMarkdown(results, aggregates);
    } else {
      printTerminal(results, aggregates);
    }

    if (values.report) {
      const outPath = writeReport(
        results,
        aggregates,
        values['report-dir'] as string,
      );
      console.error(`\n📝 Report written to ${outPath}`);
    }
  } finally {
    freeEncoder();
  }
}

main().catch((err) => {
  console.error('\n❌ Benchmark failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
