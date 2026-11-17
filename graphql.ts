// GraphQL v4 for the forge: a hand-rolled parser and executor covering the documents gh and
// github-mcp-server actually send (see the kit's checks-graphql.ts): viewer and repository reads,
// issue/pull-request connections with cursor pagination, the create/close/merge/comment mutations,
// Relay node(id:) and the __type introspection probes. Unknown fields are GraphQL errors on a 200,
// unknown repositories are data.repository = null, and a JSON array body is operation batching.

import { Forge, Repo, type CommentRec, type IssueRec, type PullRec } from './forge.ts';

type Send = (status: number, body: unknown, headers?: Record<string, string>) => void;

// ------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, and never the plain database id.
// ------------------------------------------------------------------------------------------------

function encodeId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts].join(':'), 'utf8').toString('base64url');
}

function decodeId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// The schema the introspection probes read (field/enum names; resolvers live below).
// ------------------------------------------------------------------------------------------------

const OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'isFork', 'url', 'createdAt', 'updatedAt', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt',
    'updatedAt', 'closed', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'url', 'author', 'createdAt', 'updatedAt', 'mergeCommit', 'additions', 'deletions',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  User: ['login', 'id', 'name', 'url', 'avatarUrl', 'email'],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'interfaces'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
};

// ------------------------------------------------------------------------------------------------
// Parser (the GraphQL subset the clients send: operations, fragments, variables, input values)
// ------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: Selection[] | null;
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, unknown>;
  selection: Selection[];
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new ParseError('unterminated block string');
        tokens.push(JSON.stringify(source.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (name !== null) {
      tokens.push(name[0]);
      i += name[0].length;
      continue;
    }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (number !== null) {
      tokens.push(number[0]);
      i += number[0].length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { typeCondition: string; selection: Selection[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        const variableDefaults = new Map<string, unknown>();
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.parseType();
            if (this.peek() === '=') {
              this.next();
              variableDefaults.set(varName, literalValue(this.parseValue()));
            }
          }
          this.expect(')');
        }
        // Directives are not used by the suite's documents; skip any that appear.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.parseArguments();
        }
        operations.push({ type, name, variableDefaults, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new ParseError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.peek() === '(' ? this.parseArguments() : new Map<string, Value>();
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseArguments(): Map<string, Value> {
    this.expect('(');
    const args = new Map<string, Value>();
    while (this.peek() !== ')') {
      const key = this.next();
      this.expect(':');
      args.set(key, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<[string, Value]> = [];
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'scalar', value: JSON.parse(token) as unknown };
    if (token === 'true') return { kind: 'scalar', value: true };
    if (token === 'false') return { kind: 'scalar', value: false };
    if (token === 'null') return { kind: 'scalar', value: null };
    if (/^-?\d/.test(token)) return { kind: 'scalar', value: Number(token) };
    return { kind: 'scalar', value: token }; // an enum literal
  }
}

/** A Value with no variables in it, as a plain JS value (for variable defaults). */
function literalValue(value: Value): unknown {
  switch (value.kind) {
    case 'scalar':
      return value.value;
    case 'list':
      return value.items.map(literalValue);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = literalValue(entry);
      return out;
    }
    case 'var':
      return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Executor
// ------------------------------------------------------------------------------------------------

interface Node {
  __t: string;
  [key: string]: unknown;
}

const node = (type: string, props: Record<string, unknown>): Node => ({ __t: type, ...props });

class GqlError extends Error {}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: Selection[] }>;
  errors: Array<{ message: string }>;
}

function resolveValue(ctx: Ctx, value: Value | undefined): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'scalar':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(ctx, entry);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(ctx, value);
  return out;
}

function repoNode(repo: Repo): Node {
  return node('Repository', { repo });
}

function issueNode(repo: Repo, issue: IssueRec): Node {
  return node('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: PullRec): Node {
  return node('PullRequest', { repo, pull });
}

function repoById(forge: Forge, id: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function nodeById(forge: Forge, id: string): Node | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = repoById(forge, Number(decoded.parts[0]));
    return repo === null ? null : repoNode(repo);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const repo = repoById(forge, Number(decoded.parts[0]));
    if (repo === null) return null;
    const number = Number(decoded.parts[1]);
    const found = decoded.type === 'Issue' ? repo.issues.get(number) : repo.pulls.get(number);
    if (found === undefined) return null;
    return decoded.type === 'Issue' ? issueNode(repo, found as IssueRec) : pullNode(repo, found as PullRec);
  }
  if (decoded.type === 'User') return node('User', { login: decoded.parts[0] ?? '' });
  return null;
}

function issueCursor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`, 'utf8').toString('base64url');
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Node {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction ?? 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const total = issues.length;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const number = Number(decoded.replace('issue-cursor:', ''));
      const index = issues.findIndex((issue) => issue.number === number);
      if (index !== -1) issues = issues.slice(index + 1);
    } catch {
      // An unreadable cursor pages from the start.
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : issues.length;
  const page = issues.slice(0, first);
  const last = page[page.length - 1];
  return node('IssueConnection', {
    nodes: page.map((issue) => issueNode(repo, issue)),
    totalCount: total,
    pageInfo: node('PageInfo', {
      hasNextPage: issues.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? issueCursor((page[0] as IssueRec).number) : null,
      endCursor: last !== undefined ? issueCursor(last.number) : null,
    }),
  });
}

function resolveField(ctx: Ctx, type: string, source: Node, field: FieldNode): unknown {
  const { forge } = ctx;
  const args = argsOf(ctx, field);
  switch (type) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return node('User', { login: forge.viewerLogin ?? '' });
        case 'repository': {
          const repo = forge.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === null ? null : repoNode(repo);
        }
        case 'node':
          return nodeById(forge, String(args.id ?? ''));
        case '__type': {
          const name = String(args.name ?? '');
          return OBJECT_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined ? node('__Type', { typeName: name }) : null;
        }
        case '__schema':
          return node('__Schema', {});
        default:
          return null;
      }
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      switch (field.name) {
        case 'createIssue': {
          const decoded = decodeId(String(input.repositoryId ?? ''));
          const repo = decoded !== null && decoded.type === 'Repository' ? repoById(forge, Number(decoded.parts[0])) : null;
          if (repo === null) throw new GqlError('repository not found');
          const created = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
          if ('badLabel' in created) throw new GqlError('label not found');
          return node('CreateIssuePayload', { issue: issueNode(repo, created) });
        }
        case 'closeIssue': {
          const target = nodeById(forge, String(input.issueId ?? ''));
          if (target === null || target.__t !== 'Issue') throw new GqlError('issue not found');
          const issue = target.issue as IssueRec;
          issue.state = 'closed';
          return node('CloseIssuePayload', { issue: target });
        }
        case 'createPullRequest': {
          const decoded = decodeId(String(input.repositoryId ?? ''));
          const repo = decoded !== null && decoded.type === 'Repository' ? repoById(forge, Number(decoded.parts[0])) : null;
          if (repo === null) throw new GqlError('repository not found');
          const created = forge.createPull(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), String(input.body ?? ''));
          if ('error' in created) throw new GqlError(created.error);
          return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, created) });
        }
        case 'mergePullRequest': {
          const target = nodeById(forge, String(input.pullRequestId ?? ''));
          if (target === null || target.__t !== 'PullRequest') throw new GqlError('pull request not found');
          const repo = target.repo as Repo;
          const pull = target.pull as PullRec;
          const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
          const result = forge.mergePull(repo, pull, method);
          if ('problem' in result) throw new GqlError(result.problem === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request is not open');
          return node('MergePullRequestPayload', { pullRequest: target });
        }
        case 'addComment': {
          const target = nodeById(forge, String(input.subjectId ?? ''));
          if (target === null || target.__t !== 'Issue') throw new GqlError('subject not found');
          const repo = target.repo as Repo;
          const issue = target.issue as IssueRec;
          const comment = forge.addComment(repo, issue, String(input.body ?? ''));
          return node('AddCommentPayload', {
            commentEdge: node('IssueCommentEdge', { node: node('IssueComment', { repo, comment }), cursor: null }),
          });
        }
        default:
          return null;
      }
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field.name) {
        case 'id':
          return encodeId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${forge.viewerLogin ?? ''}/${repo.name}`;
        case 'owner':
          return node('User', { login: forge.viewerLogin ?? '' });
        case 'defaultBranchRef':
          return node('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issuesConnection(ctx, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : pulls.length;
          return node('PullRequestConnection', {
            nodes: pulls.slice(0, first).map((pull) => pullNode(repo, pull)),
            totalCount: pulls.length,
            pageInfo: node('PageInfo', { hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }),
          });
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      switch (field.name) {
        case 'id':
          return encodeId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'repository':
          return repoNode(repo);
        case 'author':
          return node('User', { login: forge.viewerLogin ?? '' });
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      switch (field.name) {
        case 'id':
          return encodeId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          if (pull.state !== 'open') return 'UNKNOWN';
          return forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const files = forge.pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
          return node('PullRequestChangedFileConnection', {
            nodes: files.slice(0, first).map((file) => node('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
            totalCount: files.length,
            pageInfo: node('PageInfo', { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }),
          });
        }
        case 'author':
          return node('User', { login: forge.viewerLogin ?? '' });
        default:
          return null;
      }
    }
    case 'User':
      switch (field.name) {
        case 'login':
          return source.login as string;
        case 'id':
          return encodeId('User', source.login as string);
        case 'name':
          return source.login as string;
        default:
          return null;
      }
    case 'Ref':
      return field.name === 'name' ? (source.name as string) : null;
    case 'PageInfo':
      return (source[field.name] as unknown) ?? null;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      return (source[field.name] as unknown) ?? null;
    case 'PullRequestChangedFile':
      return (source[field.name] as unknown) ?? null;
    case 'IssueComment': {
      const repo = source.repo as Repo;
      const comment = source.comment as CommentRec;
      switch (field.name) {
        case 'id':
          return encodeId('IssueComment', repo.id, comment.id);
        case 'body':
          return comment.body;
        case 'author':
          return node('User', { login: forge.viewerLogin ?? '' });
        default:
          return null;
      }
    }
    case 'IssueCommentEdge':
      return (source[field.name] as unknown) ?? null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return (source[field.name] as unknown) ?? null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return (source[field.name] as unknown) ?? null;
    case 'AddCommentPayload':
      return (source[field.name] as unknown) ?? null;
    case '__Type': {
      const typeName = source.typeName as string;
      switch (field.name) {
        case 'name':
          return typeName;
        case 'kind':
          return ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
        case 'fields':
          return (OBJECT_FIELDS[typeName] ?? []).map((name) => node('__Field', { fieldName: name }));
        case 'enumValues':
          return (ENUM_VALUES[typeName] ?? []).map((name) => node('__EnumValue', { valueName: name }));
        default:
          return null;
      }
    }
    case '__Field':
      return field.name === 'name' ? (source.fieldName as string) : null;
    case '__EnumValue':
      return field.name === 'name' ? (source.valueName as string) : null;
    default:
      return null;
  }
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Node).__t === 'string';
}

function executeSelection(ctx: Ctx, type: string, source: Node, selections: readonly Selection[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === type || selection.typeCondition === 'Node') {
        executeSelection(ctx, type, source, selection.selection, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === type || fragment.typeCondition === 'Node')) {
        executeSelection(ctx, type, source, fragment.selection, out);
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = type;
      continue;
    }
    const introspection = type === 'Query' && (field.name === '__type' || field.name === '__schema');
    if (!introspection && field.name.startsWith('__')) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    const known = OBJECT_FIELDS[type];
    if (!introspection && known !== undefined && !known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, type, source, field);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'Internal error' });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field.selection);
  }
}

function completeValue(ctx: Ctx, value: unknown, selection: Selection[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection));
  if (isNode(value)) {
    if (selection === null) return null;
    const out: Record<string, unknown> = {};
    executeSelection(ctx, value.__t, value, selection, out);
    return out;
  }
  return value;
}

function executeOperation(forge: Forge, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ message: 'A GraphQL request must be a JSON object' }] };
  }
  const request = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'A GraphQL request must carry a query string' }] };
  }
  let document: { operations: Operation[]; fragments: Map<string, { typeCondition: string; selection: Selection[] }> };
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };
  const variables: Record<string, unknown> = {};
  for (const [key, value] of operation.variableDefaults) variables[key] = value;
  if (request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)) {
    for (const [key, value] of Object.entries(request.variables as Record<string, unknown>)) variables[key] = value;
  }
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelection(ctx, rootType, node(rootType, {}), operation.selection, data);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** POST /api/graphql: one operation object, or a JSON array of them answered in order. */
export function handleGraphQL(forge: Forge, raw: Buffer, send: Send): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    send(400, { message: 'Malformed JSON in request body' });
    return;
  }
  if (Array.isArray(parsed)) {
    send(200, parsed.map((entry) => executeOperation(forge, entry)));
    return;
  }
  send(200, executeOperation(forge, parsed));
}
