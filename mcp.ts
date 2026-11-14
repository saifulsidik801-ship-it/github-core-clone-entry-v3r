// mcp.ts — the Model Context Protocol endpoint at /mcp.
//
// JSON-RPC 2.0 over streamable HTTP, answered as plain JSON. The modern era
// (revision 2026-07-28) is served through server/discover; the handshake era
// is served through initialize + notifications/initialized. Twelve tools act
// on the same store REST serves, so an object created over MCP reads back
// over /api/v3 with the same id.
//
// The tools array is built once at load time and serialized from that same
// object on every call, so two tools/list answers are byte for byte alike.

import { diffTrees, listBranches, squashConflicts } from './refs.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import {
  branchTip,
  commitTree,
  writeCommit,
  type Issue,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER_LOGIN } from './seed.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const TOOLS: ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Read one repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'list_repos',
    'List the repositories owned by a user.',
    {
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
    },
    [],
  ),
  tool(
    'create_issue',
    'Open a new issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'get_issue',
    'Read one issue by repository and number.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_comment',
    'Add a comment to an issue.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
      body: { type: 'string', description: 'The comment body.' },
    },
    ['owner', 'repo', 'issue_number', 'body'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'get_pull_request',
    'Read one pull request by repository and number.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'list_pull_requests',
    'List the pull requests of a repository, optionally filtered by state.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request with a squash commit onto its base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  tool(
    'list_branches',
    'List the branches of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
];

// ---------------------------------------------------------------------------
// tool results
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function result(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function loadRepoForTool(store: Store, args: Record<string, unknown>): { repo: Repo | null; error: string | null } {
  const owner = asText(args.owner) || VIEWER_LOGIN;
  const name = asText(args.repo);
  if (name === '') return { repo: null, error: 'repo is required' };
  if (owner !== VIEWER_LOGIN) return { repo: null, error: `repository ${owner}/${name} does not exist` };
  const repo = store.getRepo(owner, name);
  if (!repo) return { repo: null, error: `repository ${owner}/${name} does not exist` };
  return { repo, error: null };
}

function checkRequired(def: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of def.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      return `missing required argument: ${name}`;
    }
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const def = TOOLS.find((candidate) => candidate.name === name);
  if (!def) throw new Error(`unknown tool ${name}`);
  const missing = checkRequired(def, args);
  if (missing) return toolError(missing);

  switch (name) {
    case 'create_repo': {
      const repoName = asText(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError(`repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        asText(args.description),
        args.private === true,
      );
      return result(repoJson(repo));
    }
    case 'get_repo': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      return result(repoJson(loaded.repo));
    }
    case 'list_repos': {
      const owner = asText(args.owner) || VIEWER_LOGIN;
      if (owner !== VIEWER_LOGIN) return result([]);
      return result(store.listRepos(owner).map((repo) => repoJson(repo)));
    }
    case 'create_issue': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const issue = store.createIssue(loaded.repo, asText(args.title), asText(args.body), []);
      return result(issueJson(loaded.repo, issue));
    }
    case 'get_issue': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : store.getIssue(loaded.repo, number);
      if (!issue) return toolError(`issue #${String(args.issue_number)} does not exist`);
      return result(issueJson(loaded.repo, issue));
    }
    case 'list_issues': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const state = asText(args.state) || 'open';
      const list = loaded.repo.issues.filter((issue: Issue) => state === 'all' || issue.state === state);
      return result(list.map((issue: Issue) => issueJson(loaded.repo!, issue)));
    }
    case 'create_comment': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : store.getIssue(loaded.repo, number);
      if (!issue) return toolError(`issue #${String(args.issue_number)} does not exist`);
      const comment = store.addComment(issue, asText(args.body));
      return result({ id: comment.id, body: comment.body, created_at: comment.createdAt });
    }
    case 'create_pull_request': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const repo = loaded.repo;
      const head = asText(args.head);
      const base = asText(args.base);
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null) return toolError(`head branch '${head}' does not exist`);
      if (baseSha === null) return toolError(`base branch '${base}' does not exist`);
      const pull = store.createPull(repo, asText(args.title), asText(args.body), head, base, headSha, baseSha);
      const headTree = commitTree(repo, headSha);
      const baseTree = commitTree(repo, baseSha);
      pull.files = headTree !== null && baseTree !== null ? diffTrees(repo, baseTree, headTree) : [];
      pull.mergeable = squashConflicts(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
      return result(pullJson(repo, pull));
    }
    case 'get_pull_request': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const number = asNumber(args.pull_number);
      const pull = number === null ? undefined : store.getPull(loaded.repo, number);
      if (!pull) return toolError(`pull request #${String(args.pull_number)} does not exist`);
      return result(pullJson(loaded.repo, pull));
    }
    case 'list_pull_requests': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const state = asText(args.state) || 'open';
      const list = loaded.repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return result(list.map((pull) => pullJson(loaded.repo!, pull)));
    }
    case 'merge_pull_request': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      const repo = loaded.repo;
      const number = asNumber(args.pull_number);
      const pull = number === null ? undefined : store.getPull(repo, number);
      if (!pull) return toolError(`pull request #${String(args.pull_number)} does not exist`);
      if (pull.merged) return toolError('pull request is already merged');
      const headSha = branchTip(repo, pull.headRef);
      const baseSha = branchTip(repo, pull.baseRef);
      if (headSha === null || baseSha === null) return toolError('head or base branch is gone');
      if (squashConflicts(repo, baseSha, headSha)) return toolError('merge conflict');
      const headTree = commitTree(repo, headSha);
      if (headTree === null) return toolError('head has no tree');
      const squashSha = writeCommit(store, repo, pull.baseRef, headTree, pull.title);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = '2024-01-01T00:00:00Z';
      pull.mergeSha = squashSha;
      return result({ merged: true, number: pull.number, sha: squashSha, state: 'closed' });
    }
    case 'list_branches': {
      const loaded = loadRepoForTool(store, args);
      if (loaded.error || !loaded.repo) return toolError(loaded.error ?? 'repository not found');
      return result(listBranches(loaded.repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

export interface McpReply {
  status: number;
  body: string;
}

function rpcResult(id: unknown, value: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: value }) };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

/** Try to recover the request id out of a body that is not JSON. */
function idFromBrokenBody(text: string): unknown {
  const match = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
  if (!match) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) return raw.slice(1, -1);
  return Number.parseInt(raw, 10);
}

/**
 * Answer one POST /mcp body. `hasAuth` is false when no Authorization header
 * was sent: every method then answers 401 before anything else.
 */
export function handleMcp(store: Store, bodyText: string, hasAuth: boolean): McpReply {
  if (!hasAuth) return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: idFromBrokenBody(bodyText), error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params)
    ? record.params
    : {}) as Record<string, unknown>;

  // A notification carries no id and wants no answer body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED.includes(offered) ? offered : MCP_REVISION;
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {}) as Record<string, unknown>;
      if (!TOOLS.some((candidate) => candidate.name === name)) {
        return rpcError(id, -32602, `unknown tool ${name}`);
      }
      try {
        return rpcResult(id, callTool(store, name, args));
      } catch (err) {
        return rpcResult(id, toolError((err as Error).message));
      }
    }
    default: {
      return rpcError(id, -32601, `method not found: ${method}`);
    }
  }
}
