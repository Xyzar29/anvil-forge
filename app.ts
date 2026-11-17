// Anvil: a single-process, GitHub-compatible git forge.
//
// One HTTP server carries all four surfaces the suite drives:
//   /{owner}/{repo}.git/...   git smart HTTP (protocol v2 and v0 upload-pack, v0 receive-pack)
//   /api/v3/...               the REST v3 resources (repos, branches, commits, contents, labels,
//                             issues, comments, pull requests, merges)
//   /api/graphql              GraphQL v4 (graphql.ts)
//   /mcp                      the Model Context Protocol endpoint (mcp.ts)
// over the in-memory domain in forge.ts, with the git object model in gitstore.ts. Standard
// library only; no install step; the process binds an ephemeral port and main.ts runs the
// register/done lifecycle with the env.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  Repo,
  commentJson,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  type IssueRec,
  type PullRec,
} from './forge.ts';
import {
  ZERO_OID,
  closureOf,
  isAncestor,
  listCommits,
  parseCommit,
  parsePkts,
  parseTree,
  peelToCommit,
  pktLine,
  pktText,
  planFetch,
  readPack,
  sidebandWrap,
  writePack,
  type Pkt,
} from './gitstore.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_VERSION = '1.0.0';

let requestSeq = 0;

/** An HTTP error with a GitHub-shaped {message} body. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    ...(text === '' ? {} : { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) }),
    'x-github-request-id': `anvil-${requestSeq}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `anvil-${requestSeq}`,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 512 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; a malformed body is the protocol check's 400. */
function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON in request body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function requireRepo(forge: Forge, owner: string, name: string): Repo {
  const repo = forge.repoFor(owner, name);
  if (repo === null) throw new HttpError(404, 'Not Found');
  return repo;
}

// ------------------------------------------------------------------------------------------------
// Pagination (GitHub's Link header chain)
// ------------------------------------------------------------------------------------------------

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

function paginate<T>(url: URL, req: IncomingMessage, items: readonly T[]): Page<T> {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const link = (target: number): string => {
      const next = new URL(url.pathname, `http://${host}`);
      for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
      next.searchParams.set('page', String(target));
      next.searchParams.set('per_page', String(perPage));
      return next.toString();
    };
    const lastPage = Math.ceil(items.length / perPage);
    headers.link = `<${link(page + 1)}>; rel="next", <${link(lastPage)}>; rel="last"`;
  }
  return { items: slice, headers };
}

// ------------------------------------------------------------------------------------------------
// REST v3
// ------------------------------------------------------------------------------------------------

function apiRoot(forge: Forge, res: ServerResponse): void {
  sendJson(
    res,
    200,
    {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues?q={query}',
      rate_limit_url: '/api/v3/rate_limit',
      emojis_url: '/api/v3/emojis',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function createRepo(forge: Forge, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Repository creation failed: name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new HttpError(422, 'Repository creation failed: name is invalid');
  const repo = forge.createRepo(name, body.private === true, stringField(body, 'description') ?? '');
  if (repo === null) throw new HttpError(422, 'Repository already exists');
  sendJson(res, 201, repoJson(forge, repo));
}

function patchRepo(forge: Forge, repo: Repo, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    if (forge.repos.has(body.name)) throw new HttpError(422, 'Repository already exists');
    forge.repos.delete(repo.name);
    repo.name = body.name;
    forge.repos.set(repo.name, repo);
  }
  sendJson(res, 200, repoJson(forge, repo));
}

function listBranches(repo: Repo, res: ServerResponse): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, branches);
}

function getBranch(repo: Repo, branch: string, res: ServerResponse): void {
  const oid = repo.branchTip(branch);
  if (oid === null) throw new HttpError(404, 'Branch not found');
  sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
}

function authorOf(line: string): { name: string; email: string } {
  const match = /^(.*?) <(.*?)>/.exec(line);
  return { name: match?.[1] ?? line, email: match?.[2] ?? '' };
}

function getCommitsList(forge: Forge, repo: Repo, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const ref = url.searchParams.get('sha') ?? 'HEAD';
  const resolved = forge.resolveRef(repo, ref);
  const tip = resolved === null ? null : peelToCommit(repo.store, resolved);
  if (tip === null) {
    sendJson(res, 200, []);
    return;
  }
  const shas = listCommits(repo.store, tip, 10_000);
  const all = shas.map((sha) => {
    const info = parseCommit((repo.store.get(sha) as { data: Buffer }).data);
    return {
      sha,
      commit: {
        message: info.message.replace(/\n$/, ''),
        author: authorOf(info.author),
        committer: authorOf(info.committer),
        tree: { sha: info.tree },
      },
      parents: info.parents.map((parent) => ({ sha: parent })),
    };
  });
  const page = paginate(url, req, all);
  sendJson(res, 200, page.items, page.headers);
}

// ---- contents ----

/** Walk a commit's tree to one path; answers the entry kind and object id there. */
function treeEntryAt(repo: Repo, commitOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  const commit = repo.store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '') return { kind: 'dir', oid: treeOid, mode: '40000' };
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      return { kind: isDir ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000' && entry.mode !== '040000') return null;
    treeOid = entry.oid;
  }
  return null;
}

function wrapBase64(data: Buffer): string {
  const raw = data.toString('base64');
  if (raw === '') return '';
  return `${raw.replace(/(.{60})/g, '$1\n')}\n`;
}

function getContents(forge: Forge, repo: Repo, path: string, url: URL, res: ServerResponse): void {
  const ref = url.searchParams.get('ref') ?? 'HEAD';
  const resolved = forge.resolveRef(repo, ref);
  const commitOid = resolved === null ? null : peelToCommit(repo.store, resolved);
  if (commitOid === null) throw new HttpError(404, 'Not Found');
  const found = treeEntryAt(repo, commitOid, path);
  if (found === null) throw new HttpError(404, 'Not Found');
  if (found.kind === 'dir') {
    const tree = repo.store.get(found.oid);
    const entries = tree !== undefined && tree.type === 'tree' ? parseTree(tree.data) : [];
    const listing = entries.map((entry) => {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const blob = repo.store.get(entry.oid);
      return {
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: isDir ? 0 : (blob?.data.length ?? 0),
        type: isDir ? 'dir' : 'file',
      };
    });
    listing.sort((a, b) => a.path.localeCompare(b.path));
    sendJson(res, 200, listing);
    return;
  }
  const blob = repo.store.get(found.oid);
  if (blob === undefined) throw new HttpError(404, 'Not Found');
  sendJson(res, 200, {
    type: 'file',
    name: path.split('/').pop() ?? path,
    path,
    sha: found.oid,
    size: blob.data.length,
    encoding: 'base64',
    content: wrapBase64(blob.data),
  });
}

function putContents(forge: Forge, repo: Repo, path: string, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  const content = stringField(body, 'content');
  if (content === undefined) throw new HttpError(422, 'content is required');
  const message = stringField(body, 'message') ?? `Update ${path}`;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const bytes = Buffer.from(content.replace(/[\s]+/g, ''), 'base64');
  const tip = repo.branchTip(branch) ?? (branch === repo.defaultBranch ? null : repo.branchTip(repo.defaultBranch));
  const files = forge.filesAt(repo, tip);
  const existing = files.get(path);
  if (existing !== undefined) {
    const sha = stringField(body, 'sha');
    if (sha === undefined) throw new HttpError(422, 'sha is required when updating a file');
    if (sha !== existing.oid) throw new HttpError(409, 'The sha does not match the current file');
  } else if ([...files.keys()].some((key) => key.startsWith(`${path}/`))) {
    throw new HttpError(422, 'A directory exists at that path');
  }
  const blobOid = repo.store.put('blob', bytes);
  const { commit } = forge.commitFiles(repo, branch, (map) => {
    map.set(path, { oid: blobOid, mode: '100644' });
  }, message);
  sendJson(res, existing === undefined ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit },
  });
}

function deleteContents(forge: Forge, repo: Repo, path: string, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  const message = stringField(body, 'message') ?? `Delete ${path}`;
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const tip = repo.branchTip(branch);
  const files = forge.filesAt(repo, tip);
  const existing = files.get(path);
  if (existing === undefined) throw new HttpError(404, 'Not Found');
  const sha = stringField(body, 'sha');
  if (sha !== undefined && sha !== existing.oid) throw new HttpError(409, 'The sha does not match the current file');
  const { commit } = forge.commitFiles(repo, branch, (map) => {
    map.delete(path);
  }, message);
  sendJson(res, 200, { content: null, commit: { sha: commit } });
}

// ---- git data refs ----

function createRef(repo: Repo, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw new HttpError(422, 'ref and sha are required');
  const object = repo.store.get(sha);
  if (object === undefined) throw new HttpError(422, 'sha does not name an object in this repository');
  if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, object: { sha, type: object.type } });
}

function getRef(repo: Repo, ref: string, res: ServerResponse): void {
  const oid = repo.refs.get(ref);
  if (oid === undefined) throw new HttpError(404, 'Not Found');
  const object = repo.store.get(oid);
  sendJson(res, 200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

// ---- issues ----

function listIssues(forge: Forge, repo: Repo, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const state = url.searchParams.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const direction = url.searchParams.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(url, req, issues);
  sendJson(res, 200, page.items.map((issue) => issueJson(forge, repo, issue)), page.headers);
}

function createIssue(forge: Forge, repo: Repo, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  const title = stringField(body, 'title');
  if (title === undefined || title === '') throw new HttpError(422, 'Title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  const created = forge.createIssue(repo, title, stringField(body, 'body') ?? '', labels);
  if ('badLabel' in created) throw new HttpError(422, `Label "${created.badLabel}" does not exist on this repository`);
  sendJson(res, 201, issueJson(forge, repo, created));
}

function requireIssue(repo: Repo, number: number): IssueRec {
  const issue = repo.issues.get(number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

function patchIssue(forge: Forge, repo: Repo, issue: IssueRec, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((label): label is string => typeof label === 'string');
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist on this repository`);
    }
    issue.labels = labels;
  }
  sendJson(res, 200, issueJson(forge, repo, issue));
}

// ---- pull requests ----

function listPulls(forge: Forge, repo: Repo, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const state = url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.number - a.number);
  const page = paginate(url, req, pulls);
  sendJson(res, 200, page.items.map((pull) => pullJson(forge, repo, pull)), page.headers);
}

function createPull(forge: Forge, repo: Repo, raw: Buffer, res: ServerResponse): void {
  const body = jsonBody(raw);
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === undefined || head === undefined || base === undefined) throw new HttpError(422, 'title, head and base are required');
  const created = forge.createPull(repo, head, base, title, stringField(body, 'body') ?? '');
  if ('error' in created) throw new HttpError(422, created.error);
  sendJson(res, 201, pullJson(forge, repo, created));
}

function requirePull(repo: Repo, number: number): PullRec {
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  return pull;
}

function mergePull(forge: Forge, repo: Repo, pull: PullRec, raw: Buffer, res: ServerResponse): void {
  const body = raw.length === 0 ? {} : jsonBody(raw);
  const method = stringField(body, 'merge_method') ?? 'merge';
  const result = forge.mergePull(repo, pull, method);
  if ('problem' in result) {
    if (result.problem === 'conflict') throw new HttpError(405, 'Pull Request is not mergeable');
    throw new HttpError(405, 'Pull Request is not open');
  }
  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---- the REST router ----

function methodNotAllowed(res: ServerResponse, allowed: readonly string[]): void {
  sendJson(res, 405, { message: 'Method Not Allowed' }, { allow: allowed.join(', ') });
}

async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname
    .replace(/\/+$/, '')
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  // segments[0] is 'api', segments[1] is 'v3'
  const tail = segments.slice(2);

  if (tail.length === 0) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return apiRoot(forge, res);
  }
  if (tail[0] === 'meta' && tail.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
  }
  if (tail[0] === 'user' && tail.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    if (forge.viewerLogin === null) throw new HttpError(404, 'Not Found');
    return sendJson(res, 200, { login: forge.viewerLogin, id: 1000, type: 'User' });
  }
  if (tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    if (method === 'GET') {
      const page = paginate(url, req, forge.ownRepos());
      return sendJson(res, 200, page.items.map((repo) => repoJson(forge, repo)), page.headers);
    }
    if (method === 'POST') return createRepo(forge, raw, res);
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (tail[0] !== 'repos' || tail.length < 3) throw new HttpError(404, 'Not Found');

  const repo = requireRepo(forge, tail[1] as string, tail[2] as string);
  const rest = tail.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(forge, repo));
    if (method === 'PATCH') return patchRepo(forge, repo, raw, res);
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return sendJson(res, 204, undefined);
    }
    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  }
  if (rest[0] === 'branches' && rest.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return listBranches(repo, res);
  }
  if (rest[0] === 'branches') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return getBranch(repo, rest.slice(1).join('/'), res);
  }
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return getCommitsList(forge, repo, url, req, res);
  }
  if (rest[0] === 'commits' && rest.length === 2) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const sha = rest[1] as string;
    const object = repo.store.get(sha);
    if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
    const info = parseCommit(object.data);
    return sendJson(res, 200, {
      sha,
      commit: { message: info.message.replace(/\n$/, ''), author: authorOf(info.author), committer: authorOf(info.committer), tree: { sha: info.tree } },
      parents: info.parents.map((parent) => ({ sha: parent })),
    });
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(forge, repo, path, url, res);
    if (method === 'PUT') return putContents(forge, repo, path, raw, res);
    if (method === 'DELETE') return deleteContents(forge, repo, path, raw, res);
    return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'POST') return createRef(repo, raw, res);
    if (method === 'GET') {
      const all = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.store.get(oid)?.type ?? 'commit' } }));
      return sendJson(res, 200, all);
    }
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    return getRef(repo, `refs/${rest.slice(2).join('/')}`, res);
  }
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
    if (method === 'POST') {
      const body = jsonBody(raw);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') throw new HttpError(422, 'Label name is required');
      const label = forge.createLabel(repo, name, stringField(body, 'color') ?? 'ededed');
      if (label === null) throw new HttpError(422, 'Label already exists');
      return sendJson(res, 201, labelJson(label));
    }
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (rest[0] === 'issues' && rest.length === 1) {
    if (method === 'GET') return listIssues(forge, repo, url, req, res);
    if (method === 'POST') return createIssue(forge, repo, raw, res);
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (rest[0] === 'issues' && rest.length >= 2) {
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) throw new HttpError(404, 'Not Found');
    const issue = requireIssue(repo, number);
    if (rest.length === 2) {
      if (method === 'GET') return sendJson(res, 200, issueJson(forge, repo, issue));
      if (method === 'PATCH') return patchIssue(forge, repo, issue, raw, res);
      return methodNotAllowed(res, ['GET', 'PATCH']);
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') return sendJson(res, 200, issue.comments.map((comment) => commentJson(forge, comment)));
      if (method === 'POST') {
        const body = jsonBody(raw);
        const text = stringField(body, 'body');
        if (text === undefined) throw new HttpError(422, 'Body is required');
        const comment = forge.addComment(repo, issue, text);
        return sendJson(res, 201, commentJson(forge, comment));
      }
      return methodNotAllowed(res, ['GET', 'POST']);
    }
    throw new HttpError(404, 'Not Found');
  }
  if (rest[0] === 'pulls' && rest.length === 1) {
    if (method === 'GET') return listPulls(forge, repo, url, req, res);
    if (method === 'POST') return createPull(forge, repo, raw, res);
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  if (rest[0] === 'pulls' && rest.length >= 2) {
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) throw new HttpError(404, 'Not Found');
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return methodNotAllowed(res, ['PUT']);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      return mergePull(forge, repo, pull, raw, res);
    }
    const pull = requirePull(repo, number);
    if (rest.length === 2) {
      if (method !== 'GET') return methodNotAllowed(res, ['GET']);
      return sendJson(res, 200, pullJson(forge, repo, pull));
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') return methodNotAllowed(res, ['GET']);
      return sendJson(res, 200, forge.pullFiles(repo, pull));
    }
    throw new HttpError(404, 'Not Found');
  }
  throw new HttpError(404, 'Not Found');
}

// ------------------------------------------------------------------------------------------------
// Git smart HTTP
// ------------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=anvil/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=anvil/1.0';

/** The refs a repository advertises, sorted by name (branches and tags). */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) refs.push({ name, oid });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** A v0 ref advertisement (upload-pack and receive-pack share the shape). */
function advertiseV0(repo: Repo, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [pktText(`# service=${service}\n`), pktLine('flush')];
  const caps = `${capabilities} symref=HEAD:${repo.headRef()}`;
  const refs = advertisedRefs(repo);
  const headTip = repo.refs.get(repo.headRef());
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  let first = true;
  const pushLine = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktText(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktText(`${oid} ${name}\n`));
    }
  };
  pushLine(headTip ?? ZERO_OID, 'HEAD');
  for (const ref of refs) {
    pushLine(ref.oid, ref.name);
    const object = repo.store.get(ref.oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(repo.store, ref.oid);
      if (peeled !== null) parts.push(pktText(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktLine('flush'));
  return Buffer.concat(parts);
}

/** A v2 capability advertisement (upload-pack only). */
function advertiseV2(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pktText('# service=git-upload-pack\n'),
    pktText('version 2\n'),
    pktText('agent=anvil/1.0\n'),
    pktText('ls-refs=unborn\n'),
    pktText('fetch=shallow wait-for-done\n'),
    pktText('object-format=sha1\n'),
    pktLine('flush'),
  ]);
}

function infoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, owner: string, name: string, url: URL): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Missing or unknown service');
  const repo = requireRepo(forge, owner, name);
  if (service === 'git-receive-pack') {
    sendRaw(res, 200, advertiseV0(repo, service, RECEIVE_CAPS_V0), 'application/x-git-receive-pack-advertisement');
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (typeof protocol === 'string' && protocol.includes('version=2')) {
    sendRaw(res, 200, advertiseV2(repo), 'application/x-git-upload-pack-advertisement');
    return;
  }
  sendRaw(res, 200, advertiseV0(repo, service, UPLOAD_CAPS_V0), 'application/x-git-upload-pack-advertisement');
}

/** The text lines of the data packets, in order. */
function dataLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** v2 ls-refs: HEAD (with its symref), the refs, prefix filtering, peeled tags. */
function lsRefs(repo: Repo, lines: readonly string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headTip = repo.refs.get(repo.headRef());
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      out.push(pktText(`${headTip} HEAD${symrefs ? ` symref-target:${repo.headRef()}` : ''}\n`));
    } else {
      out.push(pktText(`unborn HEAD symref-target:${repo.headRef()}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.store.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo.store, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    out.push(pktText(`${line}\n`));
  }
  out.push(pktLine('flush'));
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Build and send a fetch response (v2 sections, or the v0 NAK + sideband form). */
function sendFetch(repo: Repo, args: FetchArgs, version2: boolean, res: ServerResponse): void {
  const plan = planFetch(repo.store, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(repo.store, plan.send);
  const knownHave = args.haves.find((have) => {
    const object = repo.store.get(have);
    return object !== undefined && object.type === 'commit';
  });
  if (version2) {
    const parts: Buffer[] = [pktText('acknowledgments\n')];
    parts.push(pktText(knownHave !== undefined ? `ACK ${knownHave}\n` : 'NAK\n'));
    parts.push(pktLine('delim'));
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktText('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktText(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
      parts.push(pktLine('delim'));
    }
    parts.push(pktText('packfile\n'));
    parts.push(sidebandWrap(pack, 1));
    parts.push(pktLine('flush'));
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const parts: Buffer[] = [pktText(knownHave !== undefined ? `ACK ${knownHave}\n` : 'NAK\n')];
  for (const oid of plan.shallow) parts.push(pktText(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(pack, 1));
  parts.push(pktLine('flush'));
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function uploadPack(repo: Repo, raw: Buffer, res: ServerResponse): void {
  const { packets } = parsePkts(raw);
  const lines = dataLines(packets);
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    // v2 requests are two sections: capability lines, a delim, then the arguments.
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argLines = delimIndex === -1 ? [] : dataLines(packets.slice(delimIndex + 1));
    if (command === 'ls-refs') {
      lsRefs(repo, argLines, res);
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
      for (const line of argLines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10) || null;
      }
      sendFetch(repo, args, true, res);
      return;
    }
    throw new HttpError(400, `Unknown command ${command}`);
  }
  // v0: want/shallow/deepen lines, a flush, have lines and done, a flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let negotiation = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      negotiation = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!negotiation) {
      if (line.startsWith('want ')) args.wants.push((line.slice(5).split(' ')[0] as string).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10) || null;
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    }
  }
  sendFetch(repo, args, false, res);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, raw: Buffer, res: ServerResponse): void {
  const { packets, rest } = parsePkts(raw);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] as string) && /^[0-9a-f]{40}$/.test(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      readPack(repo.store, rest);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === ZERO_OID) fail('ref does not exist');
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) fail('stale info');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const object = repo.store.get(command.newOid);
    if (object === undefined) {
      fail('unknown object');
      continue;
    }
    if (command.oldOid !== current) {
      fail(current === ZERO_OID ? 'reference already exists' : 'stale info');
      continue;
    }
    if (current !== ZERO_OID) {
      const oldCommit = peelToCommit(repo.store, current);
      const newCommit = peelToCommit(repo.store, command.newOid);
      if (oldCommit === null || newCommit === null || !isAncestor(repo.store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!capabilities.includes('report-status')) {
    sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const reportParts: Buffer[] = [pktText(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportParts.push(pktText(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(pktLine('flush'));
  const report = Buffer.concat(reportParts);
  if (capabilities.includes('side-band-64k')) {
    sendRaw(res, 200, Buffer.concat([sidebandWrap(report, 1), pktLine('flush')]), 'application/x-git-receive-pack-result');
  } else {
    sendRaw(res, 200, report, 'application/x-git-receive-pack-result');
  }
}

// ------------------------------------------------------------------------------------------------
// The server
// ------------------------------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    throw new HttpError(400, 'Bad request URL');
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';
  if (gitMatch === null && !isApi) throw new HttpError(404, 'Not Found');

  if (!forge.authenticated(req.headers.authorization ?? null)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const service = gitMatch[3] as string;
    if (service === 'info/refs') {
      if (method !== 'GET') return methodNotAllowed(res, ['GET']);
      infoRefs(forge, req, res, owner, name, url);
      return;
    }
    const repo = requireRepo(forge, owner, name);
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    const raw = await readBody(req);
    try {
      if (service === 'git-upload-pack') uploadPack(repo, raw, res);
      else receivePack(repo, raw, res);
    } catch (err) {
      // A malformed protocol body must never take the server down (the suite proves it stays up).
      if (err instanceof HttpError) throw err;
      sendRaw(res, 400, Buffer.from(`error: ${err instanceof Error ? err.message : 'bad request'}\n`, 'utf8'), 'text/plain; charset=utf-8');
    }
    return;
  }

  if (path === '/mcp') {
    const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleMcp(forge, req, raw, (status, body, headers) => sendJson(res, status, body, headers));
    return;
  }
  if (path === '/api/graphql') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    const raw = await readBody(req);
    handleGraphQL(forge, raw, (status, body, headers) => sendJson(res, status, body, headers));
    return;
  }
  const mayHaveBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const raw = mayHaveBody ? await readBody(req) : Buffer.alloc(0);
  await handleRest(forge, req, res, url, raw);
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  const server = createServer((req, res) => {
    void handle(forge, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
