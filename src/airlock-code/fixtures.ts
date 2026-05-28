/**
 * Repository + commit fixtures for the Airlock Code benchmark.
 *
 * Mirrors the six repos and thirteen commits evaluated by code-review-graph
 * (https://github.com/tirth8205/code-review-graph/tree/HEAD/code_review_graph/eval/configs)
 * so the two benchmarks can be compared row-for-row.
 *
 * The `nextjs` fixture intentionally points at the code-review-graph repo
 * itself, because their own eval config does the same — a quirk we preserve
 * for direct parity with their published numbers.
 */

export interface CommitFixture {
  sha: string;
  description: string;
  expectedChangedFiles: number;
}

export interface RepoFixture {
  name: string;
  url: string;
  language: string;
  sizeCategory: 'small' | 'medium' | 'large';
  commits: CommitFixture[];
}

export const REPO_FIXTURES: RepoFixture[] = [
  {
    name: 'express',
    url: 'https://github.com/expressjs/express',
    language: 'javascript',
    sizeCategory: 'small',
    commits: [
      {
        sha: '925a1dff1e42f1b393c977b8b77757fcf633e09f',
        description: 'fix: bump qs minimum to ^6.14.2 for CVE-2026-2391',
        expectedChangedFiles: 1,
      },
      {
        sha: 'b4ab7d65d7724d9309b6faaaf82ad492da2a6d35',
        description: 'test: include edge case tests for res.type()',
        expectedChangedFiles: 1,
      },
    ],
  },
  {
    name: 'fastapi',
    url: 'https://github.com/tiangolo/fastapi',
    language: 'python',
    sizeCategory: 'medium',
    commits: [
      {
        sha: 'fa3588c38c7473aca7536b12d686102de4b0f407',
        description: 'Fix typo for client_secret in OAuth2 form docstrings',
        expectedChangedFiles: 1,
      },
      {
        sha: '0227991a01e61bf5cdd93cc00e9e243f52b47a4a',
        description: 'Exclude spam comments from statistics in scripts/people.py',
        expectedChangedFiles: 1,
      },
    ],
  },
  {
    name: 'flask',
    url: 'https://github.com/pallets/flask',
    language: 'python',
    sizeCategory: 'small',
    commits: [
      {
        sha: 'fbb6f0bc4c60a0bada0e03c3480d0ccf30a3c1df',
        description: 'all teardown callbacks are called despite errors',
        expectedChangedFiles: 10,
      },
      {
        sha: 'a29f88ce6f2f9843bd6fcbbfce1390a2071965d6',
        description: 'document that headers must be set before streaming',
        expectedChangedFiles: 4,
      },
    ],
  },
  {
    name: 'gin',
    url: 'https://github.com/gin-gonic/gin',
    language: 'go',
    sizeCategory: 'small',
    commits: [
      {
        sha: '052d1a79aafe3f04078a2716f8e77d4340308383',
        description: 'feat(render): add PDF renderer and tests',
        expectedChangedFiles: 5,
      },
      {
        sha: '472d086af2acd924cb4b9d7be0525f7d790f69bc',
        description: 'fix(tree): panic in findCaseInsensitivePathRec with RedirectFixedPath',
        expectedChangedFiles: 2,
      },
      {
        sha: '5c00df8afadd06cc5be530dde00fe6d9fa4a2e4a',
        description: 'fix(render): write content length in Data.Render',
        expectedChangedFiles: 2,
      },
    ],
  },
  {
    name: 'httpx',
    url: 'https://github.com/encode/httpx',
    language: 'python',
    sizeCategory: 'small',
    commits: [
      {
        sha: 'ae1b9f66238f75ced3ced5e4485408435de10768',
        description: 'Expose FunctionAuth in __all__',
        expectedChangedFiles: 3,
      },
      {
        sha: 'b55d4635701d9dc22928ee647880c76b078ba3f2',
        description: 'Upgrade Python type checker mypy',
        expectedChangedFiles: 4,
      },
    ],
  },
  {
    name: 'nextjs',
    url: 'https://github.com/tirth8205/code-review-graph',
    language: 'python',
    sizeCategory: 'medium',
    commits: [
      {
        sha: '528801f841e519567ef54d6e52e9b9831d162e1b',
        description: 'feat: add multi-platform MCP server installation support',
        expectedChangedFiles: 3,
      },
      {
        sha: '84bde35459c52e1e0c4b25c6c4799743021e0fc7',
        description: 'feat: add Google Antigravity platform support for MCP install',
        expectedChangedFiles: 2,
      },
    ],
  },
];
