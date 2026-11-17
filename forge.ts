// The forge's domain state and operations, shared by the REST, git, GraphQL and MCP surfaces so an
// object created on one surface is the same object on all of them. Everything lives in memory: a
// trial starts a fresh process, and memory is what makes the timed workloads fast.

import {
  Store,
  buildCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  treeFromFlat,
  diffLineCounts,
  type ObjType,
} from './gitstore.ts';

export interface LabelDef {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
}

const EPOCH_SEC = 1_735_689_600; // 2025-01-01, the fixed epoch API-made commits derive times from

export class Repo {
  readonly store = new Store();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelDef>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;
  commitSeq = 0;
  readonly id: number;
  name: string;
  isPrivate: boolean;
  description: string;

  constructor(id: number, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  get defaultBranch(): string {
    return 'main';
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

export type RepoLookup = { repo: Repo } | { error: 'not-found' };

export class Forge {
  readonly repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** Whether a presented bearer token authenticates (no token configured means no gate). */
  authenticated(authorization: string | null): boolean {
    if (this.token === '') return true;
    return authorization === `Bearer ${this.token}`;
  }

  /** The login API-made commits are authored under. */
  identity(): { name: string; email: string } {
    const login = this.viewerLogin ?? 'anvil';
    return { name: login, email: `${login}@anvil.invalid` };
  }

  /**
   * Address a repository by owner and name. The token's login is learned lazily: the first owner
   * string that successfully addresses an existing repository binds as the token's login, and from
   * then on the same name under any other owner is not found (the suite's foreign-owner rule).
   */
  repoFor(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (this.viewerLogin === null) this.viewerLogin = owner;
    else if (this.viewerLogin !== owner) return null;
    return repo;
  }

  /** Create a repository; null when the name is taken. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** The viewer's repositories, in creation order. */
  ownRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ----------------------------------------------------------------------------------------------
  // Refs and commits
  // ----------------------------------------------------------------------------------------------

  /** Resolve a ref name (HEAD, a branch, a tag, a full ref or a raw object id) to an object id. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return repo.refs.get(repo.headRef()) ?? null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(ref) && repo.store.has(ref)) return ref;
    return null;
  }

  /** Make a commit on top of a tree with the forge's deterministic identity and clock. */
  apiCommit(repo: Repo, parents: string[], tree: string, message: string): string {
    repo.commitSeq += 1;
    const at = EPOCH_SEC + repo.commitSeq * 61;
    const who = this.identity();
    const stamp = `${who.name} <${who.email}> ${at} +0000`;
    const data = buildCommit({ tree, parents, author: stamp, committer: stamp, message });
    return repo.store.put('commit', data);
  }

  /** The flattened file map at a commit (empty for a missing commit). */
  filesAt(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const object = repo.store.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(repo.store, parseCommit(object.data).tree);
  }

  /**
   * Commit a mutation of a branch's file map. A branch that does not exist yet starts from the
   * default branch's tip (or as a root commit on an empty repository).
   */
  commitFiles(
    repo: Repo,
    branch: string,
    mutate: (files: Map<string, { oid: string; mode: string }>) => void,
    message: string,
  ): { commit: string; tree: string } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null && branch !== repo.defaultBranch) tip = repo.refs.get(repo.headRef()) ?? null;
    const files = this.filesAt(repo, tip);
    mutate(files);
    const tree = treeFromFlat(repo.store, files);
    const commit = this.apiCommit(repo, tip === null ? [] : [tip], tree, message);
    repo.refs.set(ref, commit);
    return { commit, tree };
  }

  // ----------------------------------------------------------------------------------------------
  // Issues and labels
  // ----------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): LabelDef | null {
    if (repo.labels.has(name)) return null;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): IssueRec | { badLabel: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { badLabel: name };
    }
    const issue: IssueRec = {
      number: repo.nextNumber,
      id: this.nextIssueId,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
    };
    repo.nextNumber += 1;
    this.nextIssueId += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: IssueRec, body: string): CommentRec {
    const comment = { id: this.nextCommentId, body };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ----------------------------------------------------------------------------------------------
  // Pull requests
  // ----------------------------------------------------------------------------------------------

  /** Normalise a head/base argument ("refs/heads/x", "owner:x" or "x") to a branch name. */
  static branchName(ref: string): string {
    if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
    const colon = ref.indexOf(':');
    if (colon > 0) return ref.slice(colon + 1); // the "owner:branch" label form; branch names hold no ':'
    return ref;
  }

  createPull(
    repo: Repo,
    headRaw: string,
    baseRaw: string,
    title: string,
    body: string,
  ): PullRec | { error: string } {
    const head = Forge.branchName(headRaw);
    const base = Forge.branchName(baseRaw);
    const headSha = repo.branchTip(head);
    if (headSha === null) return { error: `head branch ${head} does not exist` };
    const baseSha = repo.branchTip(base);
    if (baseSha === null) return { error: `base branch ${base} does not exist` };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        return { error: `a pull request from ${head} into ${base} is already open` };
      }
    }
    const pull: PullRec = {
      number: repo.nextNumber,
      id: this.nextIssueId,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
    };
    repo.nextNumber += 1;
    this.nextIssueId += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files of a pull request: merge-base tree against the head branch's current tree. */
  pullFiles(repo: Repo, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
    const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo.store, baseTip, headTip);
    const from = this.filesAt(repo, base);
    const to = this.filesAt(repo, headTip);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const before = from.get(path);
      const after = to.get(path);
      if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
      const oldText = before === undefined ? '' : (repo.store.get(before.oid)?.data.toString('utf8') ?? '');
      const newText = after === undefined ? '' : (repo.store.get(after.oid)?.data.toString('utf8') ?? '');
      const counts = diffLineCounts(oldText, newText);
      files.push({
        filename: path,
        status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return files;
  }

  /** A three-way merge of two tips over their merge base; null on conflict. */
  mergedFiles(
    repo: Repo,
    baseTip: string,
    headTip: string,
  ): Map<string, { oid: string; mode: string }> | null {
    const base = mergeBase(repo.store, baseTip, headTip);
    const baseFiles = this.filesAt(repo, base);
    const ours = this.filesAt(repo, baseTip);
    const theirs = this.filesAt(repo, headTip);
    const out = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...baseFiles.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean => x?.oid === y?.oid;
      if (same(o, t)) {
        if (o !== undefined) out.set(path, o);
      } else if (same(b, o)) {
        if (t !== undefined) out.set(path, t);
      } else if (same(b, t)) {
        if (o !== undefined) out.set(path, o);
      } else {
        return null;
      }
    }
    return out;
  }

  /** Whether a pull request's head merges cleanly into its base right now. */
  pullMergeable(repo: Repo, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
    const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
    if (isAncestor(repo.store, headTip, baseTip)) return true;
    return this.mergedFiles(repo, baseTip, headTip) !== null;
  }

  /**
   * Merge a pull request (squash, merge or rebase). Answers the resulting base tip, or a reason:
   * 'conflict' when the three-way merge collides, 'not-open' when the pull is not open.
   */
  mergePull(repo: Repo, pull: PullRec, method: string): { sha: string } | { problem: 'conflict' | 'not-open' } {
    if (pull.state !== 'open') return { problem: 'not-open' };
    const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
    const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
    let sha: string;
    if (isAncestor(repo.store, headTip, baseTip)) {
      sha = baseTip;
    } else if (method === 'merge') {
      const merged = this.mergedFiles(repo, baseTip, headTip);
      if (merged === null) return { problem: 'conflict' };
      const tree = treeFromFlat(repo.store, merged);
      sha = this.apiCommit(repo, [baseTip, headTip], tree, `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
    } else if (method === 'rebase') {
      const replay = this.commitsOnlyIn(repo, headTip, baseTip);
      let tip = baseTip;
      for (const source of replay) {
        const info = parseCommit((repo.store.get(source) as { data: Buffer }).data);
        tip = this.apiCommit(repo, [tip], info.tree, info.message);
      }
      sha = tip;
    } else {
      // squash (the default, and what the suite drives)
      const merged = this.mergedFiles(repo, baseTip, headTip);
      if (merged === null) return { problem: 'conflict' };
      const tree = treeFromFlat(repo.store, merged);
      const message = pull.body === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
      sha = this.apiCommit(repo, [baseTip], tree, message);
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    repo.commitSeq += 1;
    pull.mergedAt = new Date((EPOCH_SEC + repo.commitSeq * 61) * 1000).toISOString();
    return { sha };
  }

  /** Commits reachable from `tip` but not from `other`, oldest first (for a rebase replay). */
  private commitsOnlyIn(repo: Repo, tip: string, other: string): string[] {
    const excluded = new Set<string>();
    const stack = [other];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (excluded.has(oid)) continue;
      const object = repo.store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      excluded.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (oid: string): void => {
      if (seen.has(oid) || excluded.has(oid)) return;
      const object = repo.store.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) walk(parent);
      out.push(oid);
    };
    walk(tip);
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// Serializers (the REST view of the domain objects)
// ------------------------------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const login = forge.viewerLogin ?? 'anvil';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

export function labelJson(label: LabelDef): Record<string, unknown> {
  return { name: label.name, color: label.color, default: false, description: null };
}

export function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  const login = forge.viewerLogin ?? 'anvil';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

export function commentJson(forge: Forge, comment: CommentRec): Record<string, unknown> {
  const login = forge.viewerLogin ?? 'anvil';
  return {
    id: comment.id,
    body: comment.body,
    user: { login, type: 'User' },
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const login = forge.viewerLogin ?? 'anvil';
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${login}:${pull.baseRef}` },
    user: { login, type: 'User' },
    created_at: new Date(EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(EPOCH_SEC * 1000).toISOString(),
  };
}

export type { ObjType };
