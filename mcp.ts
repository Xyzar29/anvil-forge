// The Model Context Protocol endpoint (POST /mcp): JSON-RPC 2.0 over streamable HTTP, speaking
// the current 2026-07-28 revision (server/discover, no handshake) and the legacy initialize
// handshake for older clients. The tools are the github-mcp-server surface the suite drives, and
// they act on the same in-memory forge as REST, git and GraphQL — an object created here is the
// same object everywhere.

import type { IncomingMessage } from 'node:http';
import { Forge, issueJson, pullJson, repoJson, type Repo } from './forge.ts';

type Send = (status: number, body: unknown, headers?: Record<string, string>) => void;

const SERVER_INFO = { name: 'anvil', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name'),
        description: str('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: str('The repository owner (defaults to the authenticated user)'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner'), repo: str('The repository name') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner'),
        repo: str('The repository name'),
        title: str('The issue title'),
        body: str('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner'),
        repo: str('The repository name'),
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner'),
        repo: str('The repository name'),
        state: str('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner'),
        repo: str('The repository name'),
        title: str('The pull request title'),
        body: str('The pull request body'),
        head: str('The head branch to merge from'),
        base: str('The base branch to merge into'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash by default).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner'),
        repo: str('The repository name'),
        pull_number: { type: 'number', description: 'The pull request number' },
        merge_method: str('The merge method: merge, squash or rebase'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner'),
        repo: str('The repository name'),
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

class ToolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function repoArg(forge: Forge, args: Record<string, unknown>): Repo {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '' && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    owner = o ?? owner;
    repo = r ?? repo;
  }
  const found = forge.repoFor(owner, repo);
  if (found === null) throw new ToolError(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const existing = forge.repos.get(repoName);
      if (existing !== undefined) return repoJson(forge, existing);
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) throw new ToolError(`repository ${repoName} already exists`);
      return repoJson(forge, repo);
    }
    case 'get_repo':
      return repoJson(forge, repoArg(forge, args));
    case 'list_repos':
      return forge.ownRepos().map((repo) => repoJson(forge, repo));
    case 'create_issue': {
      const repo = repoArg(forge, args);
      const labels = Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [];
      const created = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', labels);
      if ('badLabel' in created) throw new ToolError(`label "${created.badLabel}" does not exist`);
      return issueJson(forge, repo, created);
    }
    case 'get_issue': {
      const repo = repoArg(forge, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new ToolError(`issue ${String(args.issue_number)} not found`);
      return issueJson(forge, repo, issue);
    }
    case 'list_issues': {
      const repo = repoArg(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return issues.map((issue) => issueJson(forge, repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoArg(forge, args);
      const created = forge.createPull(
        repo,
        String(args.head ?? ''),
        String(args.base ?? ''),
        String(args.title ?? ''),
        typeof args.body === 'string' ? args.body : '',
      );
      if ('error' in created) throw new ToolError(created.error);
      return pullJson(forge, repo, created);
    }
    case 'merge_pull_request': {
      const repo = repoArg(forge, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new ToolError(`pull request ${String(args.pull_number)} not found`);
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const result = forge.mergePull(repo, pull, method);
      if ('problem' in result) throw new ToolError(result.problem === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request is not open');
      return pullJson(forge, repo, pull);
    }
    case 'close_issue': {
      const repo = repoArg(forge, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new ToolError(`issue ${String(args.issue_number)} not found`);
      issue.state = 'closed';
      return issueJson(forge, repo, issue);
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle one JSON-RPC request object; null for a notification (no answer owed). */
function handleOne(forge: Forge, request: unknown): RpcResponse | null {
  if (!isRecord(request) || typeof request.method !== 'string') {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  }
  const id = 'id' in request ? request.id : undefined;
  const params = isRecord(request.params) ? request.params : {};
  if (id === undefined) return null; // a notification: accepted, never answered

  switch (request.method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return rpcError(id, INVALID_PARAMS, `unknown tool: ${toolName}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined);
      if (missing.length > 0) return rpcError(id, INVALID_PARAMS, `missing required argument: ${missing.join(', ')}`);
      try {
        const value = callTool(forge, toolName, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        if (err instanceof ToolError) {
          return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
        }
        return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : 'Internal error');
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `method not found: ${request.method}`);
  }
}

/** POST /mcp (authentication has already been enforced by the caller). */
export function handleMcp(forge: Forge, req: IncomingMessage, raw: Buffer, send: Send): void {
  if (req.method !== 'POST') {
    send(405, { message: 'Method Not Allowed' }, { allow: 'POST' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(400, rpcError(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: RpcResponse[] = [];
    for (const entry of parsed) {
      const response = handleOne(forge, entry);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      send(202, undefined);
      return;
    }
    send(200, responses);
    return;
  }
  const response = handleOne(forge, parsed);
  if (response === null) {
    send(202, undefined);
    return;
  }
  send(200, response);
}
