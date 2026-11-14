// store.ts — the forge's whole memory: repositories, issues, pull requests,
// labels, comments, and the git object store each repository carries.
//
// One Store holds everything; nothing is ever written to disk. Counters only
// move forward, so every id and number is stable across reads. A repository's
// `generation` bumps on any ref or object change, which is what lets the git
// layer cache whole responses and drop them the moment the repo moves.

import {
  buildCommit,
  buildTree,
  collectReachable,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectKind,
  type TreeEntry,
} from './objects.ts';
import {
  DEFAULT_BRANCH,
  FIXED_ISO_TIME,
  SERVER_IDENT,
  VIEWER_LOGIN,
  ZERO_OID,
  globalId,
  hashObject,
  isOid,
} from './seed.ts';

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  /** Stable numeric id, never reused. */
  id: number;
  /** The per-repo shared issue/PR number. */
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  /** The GET response body, built once and reused until the issue changes. */
  cachedJson: string | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Creation order, for stable list pagination. */
  seq: number;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  /** Next shared issue/PR number. */
  nextNumber: number;
  /** Bumps on any ref or object change; caches key off it. */
  generation: number;
  /** Whole-response caches, each tagged with the generation that built it. */
  fetchCache: Map<string, { gen: number; body: Buffer }>;
  lsRefsCache: Map<string, { gen: number; body: Buffer }>;
  adCache: Map<string, { gen: number; body: Buffer }>;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private repoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.repoSeq++,
      createdAt: FIXED_ISO_TIME,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      generation: 0,
      fetchCache: new Map(),
      lsRefsCache: new Map(),
      adCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Store an object, returning its id (a no-op when it is already held). */
  putObject(repo: Repo, type: ObjectKind, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Bump the generation so every cached git response for this repo goes stale. */
  touch(repo: Repo): void {
    repo.generation += 1;
  }

  // -- issues ---------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: FIXED_ISO_TIME,
      updatedAt: FIXED_ISO_TIME,
      cachedJson: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: FIXED_ISO_TIME };
    issue.comments.push(comment);
    issue.cachedJson = null;
    return comment;
  }

  // -- pull requests ----------------------------------------------------------

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): PullRequest {
    const pull: PullRequest = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      files: [],
      mergeable: 'UNKNOWN',
      createdAt: FIXED_ISO_TIME,
      updatedAt: FIXED_ISO_TIME,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }
}

// ---------------------------------------------------------------------------
// global ids (GraphQL)
// ---------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
}

// ---------------------------------------------------------------------------
// refs and commits
// ---------------------------------------------------------------------------

/** The commit a ref names, or null when the ref is missing or not a commit. */
export function refCommit(repo: Repo, ref: string): { oid: string; commit: ReturnType<typeof parseCommit> } | null {
  const oid = repo.refs.get(ref);
  if (!oid || oid === ZERO_OID) return null;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  return { oid, commit: parseCommit(object.data) };
}

/** The tip of a branch name, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid && oid !== ZERO_OID ? oid : null;
}

/** Resolve a ref argument (branch name or raw commit id) to a commit id. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    return object && object.type === 'commit' ? ref : null;
  }
  const asBranch = branchTip(repo, ref);
  if (asBranch) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag) {
    const object = repo.objects.get(asTag);
    if (object && object.type === 'tag') {
      // A tag ref peels to its target commit.
      return parseTag(object.data).object;
    }
    return asTag;
  }
  return null;
}

/** Write a commit on a branch: build the commit object, store it, move the ref. */
export function writeCommit(
  store: Store,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const parent = branchTip(repo, branch);
  const parents = parent === null ? [] : [parent];
  const data = buildCommit(treeOid, parents, message, SERVER_IDENT);
  const oid = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  store.touch(repo);
  return oid;
}

// ---------------------------------------------------------------------------
// trees and paths
// ---------------------------------------------------------------------------

/** Flatten a tree into path → {oid, mode}, walking subdirectories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, at: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Find one path inside a tree: its object id and mode, or null. */
export function findPath(repo: Repo, treeOid: string, segments: readonly string[]): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List one directory inside a tree (or the root when segments is empty). */
export function listDir(repo: Repo, treeOid: string, segments: readonly string[]): TreeEntry[] | null {
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/**
 * Put a blob at a path, building every tree on the way down. Returns the new
 * root tree id. `rootOid` may be null for an empty tree.
 */
export function putPath(
  store: Store,
  repo: Repo,
  rootOid: string | null,
  segments: readonly string[],
  blobOid: string,
  mode = '100644',
): string {
  if (segments.length === 0) throw new Error('putPath needs at least one segment');
  const rebuild = (treeOid: string | null, depth: number): string => {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const name = segments[depth]!;
    const isLeaf = depth === segments.length - 1;
    const kept: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name === name) continue;
      kept.push(entry);
    }
    if (isLeaf) {
      kept.push({ mode, name, oid: blobOid });
    } else {
      const child = entries.find((entry) => entry.name === name);
      const childOid = child && child.mode === '40000' ? child.oid : null;
      const next = rebuild(childOid, depth + 1);
      kept.push({ mode: '40000', name, oid: next });
    }
    return store.putObject(repo, 'tree', buildTree(kept));
  };
  return rebuild(rootOid, 0);
}

/**
 * Remove a path from a tree. Returns the new root tree id, or null when the
 * path was not there.
 */
export function removePath(
  store: Store,
  repo: Repo,
  rootOid: string,
  segments: readonly string[],
): string | null {
  const rebuild = (treeOid: string, depth: number): string | null => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const name = segments[depth]!;
    const target = entries.find((entry) => entry.name === name);
    if (!target) return null;
    const isLeaf = depth === segments.length - 1;
    const kept: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name === name) continue;
      kept.push(entry);
    }
    if (!isLeaf) {
      if (target.mode !== '40000') return null;
      const next = rebuild(target.oid, depth + 1);
      if (next === null) return null;
      const remaining = parseTree(repo.objects.get(next)?.data ?? Buffer.alloc(0));
      if (remaining.length > 0) kept.push({ mode: '40000', name, oid: next });
    }
    return store.putObject(repo, 'tree', buildTree(kept));
  };
  return rebuild(rootOid, 0);
}

/** The tree id a commit names. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** All objects reachable from a commit id (used to size a fetch). */
export function reachableFrom(repo: Repo, roots: readonly string[]): Set<string> {
  return collectReachable(roots, (oid) => repo.objects.get(oid));
}
