#!/usr/bin/env node
/**
 * Live Airlock Code Benchmark
 *
 * Same methodology as the simulated `benchmark.ts`, but the `graph_tokens`
 * column is measured by actually calling Airlock Code's `code_review_context`
 * tool against a real Airlock org. The `naive_tokens` and `standard_tokens`
 * columns still come from the local git clone so the baseline is identical.
 *
 * Prerequisites:
 *   - An Airlock organization with Airlock Code enabled
 *   - The six benchmark repos connected to that org (or a subset via --only)
 *
 * The tool is called with the repo filter set to `github:<owner>/<repo>` so
 * the graph query scopes to the single repository even if the org has many
 * indexed.
 *
 * Usage:
 *   npm run benchmark:code:live -- --org <slug>
 *   npm run benchmark:code:live -- --org <slug> --only httpx
 *   npm run benchmark:code:live -- --url https://mcp.air-lock.ai/org/<slug> --token <mcp-token>
 */

import { parseArgs } from 'util';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { countTokens, freeEncoder } from '../shared/token-counter.js';
import { interactiveAuth, resolveAirlockUrl } from '../shared/oauth.js';
import { MCPClient } from '../shared/mcp-client.js';
import { REPO_FIXTURES, type RepoFixture } from './fixtures.js';
import {
  ensureRepo,
  getChangedFiles,
  countNaiveTokens,
  countStandardTokens,
  type CommitTokenResult,
} from './token-efficiency.js';
import {
  buildDynamicFixture,
  parsePrModeFlags,
  type BuildFixtureOptions,
} from './pr-fixtures.js';

/**
 * Derive the `github:owner/repo` slug used as the Airlock Code `repository`
 * filter. Driven off the fixture URL so it stays in sync with what we clone.
 *
 * Accepts dotted repo names (`owner/service.api`) — the previous version's
 * `[^/.]+` rejected any `.` and silently truncated the slug.
 */
function repoFilterFor(fixture: RepoFixture): string {
  const match = fixture.url.match(
    /github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?(?:[/?#].*)?$/,
  );
  if (!match) {
    throw new Error(`Could not parse owner/repo from ${fixture.url}`);
  }
  return `github:${match[1]}/${match[2]}`;
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
  tools: Array<{ name: string; description: string; project: string }>;
  total: number;
}

/**
 * Discover the Airlock Code service slug. The org-level MCP endpoint only
 * exposes the 4 meta-tools; Airlock Code's virtual tools live under their
 * own service and are invoked via `execute_tool("<slug>/code_review_context", …)`.
 *
 * Strategy:
 *   1. List services and look for one whose slug is `airlock-code` (the
 *      default) or whose display name starts with "Airlock Code".
 *   2. If nothing matches, fall back to searching tools by name.
 *   3. If that also fails, surface the full service list so the user can
 *      see what's actually connected.
 */
async function discoverAirlockCodeSlug(client: MCPClient): Promise<string> {
  const listRaw = await client.callToolText('list_services', {});
  const list = JSON.parse(listRaw) as ListServicesResult;
  const match = list.services.find(
    (s) =>
      s.slug === 'airlock-code' ||
      s.name.toLowerCase().startsWith('airlock code'),
  );
  if (match) return match.slug;

  const searchRaw = await client.callToolText('search_tools', {
    query: 'code_review_context',
    limit: 10,
  });
  const search = JSON.parse(searchRaw) as SearchToolsResult;
  const byName = search.tools.find((t) => t.name === 'code_review_context');
  if (byName) return byName.project;

  throw new Error(
    `Could not find an Airlock Code service in this org. ` +
      `Connected services: ${list.services.map((s) => `${s.name} (${s.slug})`).join(', ')}.`,
  );
}

async function measureLiveCommit(
  client: MCPClient,
  fixture: RepoFixture,
  repoPath: string,
  commitSha: string,
  commitDescription: string,
  codeServiceSlug: string,
): Promise<CommitTokenResult> {
  // Same local-git measurements as the simulated benchmark — read-only:
  // everything reads commit trees via `git show`, never touches the working
  // tree. This is what lets `--local-repo` point at a checkout with
  // in-flight work.
  const changedFiles = getChangedFiles(repoPath, commitSha);
  const naiveTokens = countNaiveTokens(repoPath, changedFiles, commitSha);
  const standardTokens = countStandardTokens(repoPath, commitSha);

  // Org MCP endpoints only expose the 4 meta-tools, so we invoke Airlock
  // Code's virtual tool via `execute_tool(<slug>/code_review_context, …)`.
  // This is also what an agent in the org actually does, so the measured
  // tokens reflect the end-to-end cost.
  const repositoryFilter = repoFilterFor(fixture);
  const responseText = await client.callToolText('execute_tool', {
    tool: `${codeServiceSlug}/code_review_context`,
    arguments: {
      changed_files: changedFiles,
      repository: repositoryFilter,
    },
  });

  if (process.env.DEBUG) {
    console.error(
      `\n   [DEBUG] ${commitSha.slice(0, 7)} repository=${repositoryFilter} ` +
        `changed_files=${JSON.stringify(changedFiles.slice(0, 3))}…`,
    );
    console.error(
      `   [DEBUG] response (${responseText.length} chars): ${responseText.slice(0, 500)}${responseText.length > 500 ? '…' : ''}`,
    );
  }

  const graphTokens = countTokens(responseText);
  const naiveToGraphRatio =
    graphTokens > 0 ? Math.round((naiveTokens / graphTokens) * 10) / 10 : 0;
  const standardToGraphRatio =
    graphTokens > 0
      ? Math.round((standardTokens / graphTokens) * 10) / 10
      : 0;

  return {
    repo: fixture.name,
    commit: commitSha,
    description: commitDescription,
    changedFileCount: changedFiles.length,
    naiveTokens,
    standardTokens,
    graphTokens,
    naiveToGraphRatio,
    standardToGraphRatio,
  };
}

interface RunLiveOptions {
  only?: string;
  dynamicFixture?: { fixture: RepoFixture; opts: BuildFixtureOptions };
}

async function runLive(
  client: MCPClient,
  codeServiceSlug: string,
  options: RunLiveOptions = {},
): Promise<CommitTokenResult[]> {
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

  const results: CommitTokenResult[] = [];
  for (const repo of fixtures) {
    console.error(
      `\n   • ${repo.name}: ${localRepoPath ? 'using local clone' : 'cloning / fetching'}…`,
    );
    const path = ensureRepo(repo, localRepoPath);
    for (const commit of repo.commits) {
      try {
        const result = await measureLiveCommit(
          client,
          repo,
          path,
          commit.sha,
          commit.description,
          codeServiceSlug,
        );
        results.push(result);
        console.error(
          `     ✓ ${commit.sha.slice(0, 7)}  files=${result.changedFileCount}  ` +
            `naive=${result.naiveTokens}  std=${result.standardTokens}  ` +
            `graph=${result.graphTokens}  ratio=${result.naiveToGraphRatio}x`,
        );
      } catch (err) {
        console.error(
          `     ✗ ${commit.sha.slice(0, 7)} failed: ${err instanceof Error ? err.message : err}`,
        );
        console.error(
          `       (is ${repoFilterFor(repo)} connected to this Airlock org?)`,
        );
      }
    }
  }
  return results;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
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

function printTerminal(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
  orgSlug: string,
): void {
  console.log('\n' + '='.repeat(110));
  console.log(`AIRLOCK CODE TOKEN SAVINGS BENCHMARK  (live — org: ${orgSlug})`);
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
  for (const a of aggregates) {
    console.log(
      `  ${a.repo.padEnd(10)}  naive=${a.avgNaive.toLocaleString().padStart(8)}  ` +
        `graph=${a.avgGraph.toLocaleString().padStart(6)}  ratio=${a.avgNaiveRatio}x`,
    );
  }

  const totalNaive = results.reduce((s, r) => s + r.naiveTokens, 0);
  const totalGraph = results.reduce((s, r) => s + r.graphTokens, 0);
  const overallRatio = totalGraph > 0 ? totalNaive / totalGraph : 0;

  console.log('\n' + '='.repeat(110));
  console.log(`Overall reduction (${results.length} commits): ${round1(overallRatio)}x`);
  console.log('='.repeat(110));
}

function printJson(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
  orgSlug: string,
): void {
  console.log(
    JSON.stringify(
      {
        benchmark: 'airlock-code-token-efficiency',
        mode: 'live',
        org: orgSlug,
        generatedAt: new Date().toISOString(),
        perCommit: results,
        perRepo: aggregates,
      },
      null,
      2,
    ),
  );
}

function writeReport(
  results: CommitTokenResult[],
  aggregates: RepoAggregate[],
  orgSlug: string,
  outDir: string,
): string {
  mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  lines.push(`# Airlock Code — Token Efficiency (live, org: ${orgSlug})`);
  lines.push('');
  lines.push(
    `Generated ${new Date().toISOString()} against \`${orgSlug}\`'s live Airlock Code tools.`,
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
  const outPath = join(outDir, `summary-live-${orgSlug}.md`);
  writeFileSync(outPath, lines.join('\n') + '\n');
  return outPath;
}

function printUsage(): void {
  console.log(`
Airlock Code Token Savings Benchmark (live) — measures actual graph response
sizes against your Airlock org and compares them to the local-file baseline.

Usage:
  npm run benchmark:code:live -- --org <slug>
  npm run benchmark:code:live -- --org <slug> --only httpx
  npm run benchmark:code:live -- --url <mcp-endpoint-url> --token <mcp-token>

Your-own-PRs mode:
  npm run benchmark:code:live -- --org my-org --repo Air-Lock-AI/airlock --last 20
  npm run benchmark:code:live -- --org my-org --repo Air-Lock-AI/airlock --pr 1105,1104
  npm run benchmark:code:live -- --org my-org --repo Air-Lock-AI/airlock --last 20 \\
      --local-repo ~/projects/airlock

Options:
  --org <slug>       Your Airlock organization slug (required unless --url)
  --url <url>        Full MCP endpoint URL (alternative to --org)
  --token <token>    MCP access token (will prompt via OAuth if omitted)
  --env <env>        production (default) | staging | <stage> for dev
  --only <repo>      Run against a single default fixture
  --repo <owner/name>   Target repo (enables your-own-PRs mode)
  --pr <nums>        Comma-separated PR numbers (merge commits)
  --last <n>         Include the last N merged PRs
  --sha <shas>       Raw commit SHAs (comma-separated)
  --local-repo <path>   Use an existing local clone instead of cloning
  --format <fmt>     terminal (default) | json
  --report           Write a summary-live-<org>.md into evaluate/reports/
  --report-dir <p>   Override report directory (default: evaluate/reports)
  --help             Show this help message

Either the default fixture repos or your --repo target must be connected to
your Airlock Code org — the benchmark passes \`repository=github:<owner>/<repo>\`
so the graph query scopes correctly. Private repos resolve via \`gh\`.
`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      org: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      env: { type: 'string', default: 'production' },
      only: { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      last: { type: 'string' },
      sha: { type: 'string' },
      'local-repo': { type: 'string' },
      format: { type: 'string', default: 'terminal' },
      report: { type: 'boolean', default: false },
      'report-dir': {
        type: 'string',
        default: join(process.cwd(), 'evaluate', 'reports'),
      },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  let url: string;
  if (values.url) {
    url = values.url;
  } else if (values.org) {
    url = resolveAirlockUrl(values.org, values.env ?? 'production');
  } else {
    console.error('Error: Either --org or --url is required\n');
    printUsage();
    process.exit(1);
  }

  const orgSlug = url.match(/\/org\/([^/?]+)/)?.[1] ?? 'unknown';

  let token = values.token;
  if (!token) {
    const mcpBaseUrl = url.replace(/\/+$/, '').replace(/\/org\/[^/]+$/, '');
    try {
      token = await interactiveAuth(mcpBaseUrl);
    } catch (err) {
      console.error(
        '\n❌ Authentication failed:',
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  }

  const client = new MCPClient(url, token);
  console.error(`\n🔌 Connecting to ${url}…`);
  await client.initialize();
  console.error('   ✓ MCP session established');

  console.error('🔎 Discovering Airlock Code service…');
  const codeServiceSlug = await discoverAirlockCodeSlug(client);
  console.error(`   ✓ Using service slug: ${codeServiceSlug}`);

  const prOpts = parsePrModeFlags(values as never);
  const dynamicFixture = prOpts
    ? { fixture: buildDynamicFixture(prOpts), opts: prOpts }
    : undefined;

  try {
    const results = await runLive(client, codeServiceSlug, {
      only: values.only as string | undefined,
      dynamicFixture,
    });
    if (results.length === 0) {
      console.error(
        '\n❌ No commits were measured. Check that the repo is connected to the ' +
          "org and indexed, and that gh can see the PRs you're targeting.",
      );
      process.exit(1);
    }
    const aggregates = aggregateByRepo(results);

    if (values.format === 'json') {
      printJson(results, aggregates, orgSlug);
    } else {
      printTerminal(results, aggregates, orgSlug);
    }

    if (values.report) {
      const outPath = writeReport(
        results,
        aggregates,
        orgSlug,
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
