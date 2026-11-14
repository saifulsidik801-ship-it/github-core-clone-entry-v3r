// rest.ts — the REST v3 surface under /api/v3.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id (main.ts adds
// that header). No token is 401, a foreign owner is 404 (never 403), an
// unknown route is a JSON 404, and a malformed JSON body is a 400. All dates
// are the fixed timestamp, all ids and numbers are stable counters.

import { diffTrees, listBranches, listCommits, squashConflicts } from './refs.ts';
import {
  branchTip as storeBranchTip,
  commitTree as storeCommitTree,
  findPath,
  listDir,
  putPath,
  removePath,
  resolveRef,
  writeCommit,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { FIXED_ISO_TIME, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './seed.ts';

export interface RestReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function ok(status: number, value: unknown, headers?: Record<string, string>): RestReply {
  return { status, body: JSON.stringify(value), headers };
}

function fail(status: number, message: string): RestReply {
  return { status, body: JSON.stringify({ message }) };
}

function noContent(): RestReply {
  return { status: 204, body: '' };
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** The cached GET-issue body; rebuilt only when the issue changes. */
export function cachedIssueJson(repo: Repo, issue: Issue): string {
  if (issue.cachedJson === null) issue.cachedJson = JSON.stringify(issueJson(repo, issue));
  return issue.cachedJson;
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: 1, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: 1, type: 'User' },
    created_at: comment.createdAt,
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

/** Slice one page out of a list and build the Link header for the next page. */
function paginate(
  origin: string,
  basePath: string,
  query: URLSearchParams,
  total: number,
): { page: number; perPage: number; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    link = `<${origin}${basePath}?${next.toString()}>; rel="next"`;
  }
  return { page, perPage, link };
}

function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  origin: string;
  bodyText: string;
}

/** Parse the request body as JSON when one is present; 400 on bad JSON. */
function parseBody(ctx: RestContext): { value: Record<string, unknown> | null; error: RestReply | null } {
  if (ctx.bodyText.trim() === '') return { value: null, error: null };
  try {
    const parsed = JSON.parse(ctx.bodyText) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, error: null };
    }
    return { value: null, error: fail(400, 'request body must be a JSON object') };
  } catch {
    return { value: null, error: fail(400, 'malformed JSON body') };
  }
}

/** Load a repo for an owner/name pair: 404 for a foreign owner or a missing repo. */
function loadRepo(ctx: RestContext, owner: string, name: string): { repo: Repo | null; error: RestReply | null } {
  if (owner !== VIEWER_LOGIN) return { repo: null, error: fail(404, 'Not Found') };
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return { repo: null, error: fail(404, 'Not Found') };
  return { repo, error: null };
}

export function routeRest(ctx: RestContext): RestReply {
  const seg = ctx.segments;
  const method = ctx.method;

  // -- API root and meta ------------------------------------------------------
  if (seg.length === 0) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok(
      200,
      {
        current_user_url: `${ctx.origin}/api/v3/user`,
        repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok(200, { installed_version: '1.0.0' });
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok(200, {
      login: VIEWER_LOGIN,
      id: 1,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      created_at: FIXED_ISO_TIME,
    });
  }

  // -- POST /user/repos, GET /user/repos --------------------------------------
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'name is required');
      if (ctx.store.getRepo(VIEWER_LOGIN, name)) {
        return fail(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      return ok(201, repoJson(repo));
    }
    if (method === 'GET') {
      const all = ctx.store.listRepos(VIEWER_LOGIN);
      const { page, perPage, link } = paginate(ctx.origin, '/api/v3/user/repos', ctx.query, all.length);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      return ok(200, pageOf(all, page, perPage).map((repo) => repoJson(repo)), headers);
    }
    return fail(405, 'Method Not Allowed');
  }

  // -- /repos/{owner}/{repo}/... ----------------------------------------------
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]!;
    const name = seg[2]!;
    const rest = seg.slice(3);
    const loaded = loadRepo(ctx, owner, name);
    if (loaded.error) return loaded.error;
    const repo = loaded.repo!;
    return routeRepo(ctx, repo, rest);
  }

  return fail(404, 'Not Found');
}

function routeRepo(ctx: RestContext, repo: Repo, rest: string[]): RestReply {
  const method = ctx.method;

  // -- the repository itself ---------------------------------------------------
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      return noContent();
    }
    return fail(405, 'Method Not Allowed');
  }

  // -- branches ------------------------------------------------------------------
  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return fail(405, 'Method Not Allowed');
      return ok(
        200,
        listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })),
      );
    }
    if (rest.length === 2) {
      if (method !== 'GET') return fail(405, 'Method Not Allowed');
      const sha = storeBranchTip(repo, rest[1]!);
      if (sha === null) return fail(404, 'Not Found');
      return ok(200, { name: rest[1], commit: { sha }, protected: false });
    }
    return fail(404, 'Not Found');
  }

  // -- commits ---------------------------------------------------------------------
  if (rest[0] === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return fail(404, 'Not Found');
    const ref = ctx.query.get('sha') ?? undefined;
    const tip = resolveRef(repo, ref);
    if (tip === null) return fail(404, 'Not Found');
    return ok(
      200,
      listCommits(repo, tip).map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO_TIME },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO_TIME },
        },
      })),
    );
  }

  // -- git refs ----------------------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/')) return fail(422, 'ref must start with refs/');
      if (!ctx.store.getObject(repo, sha)) return fail(422, 'object does not exist');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      ctx.store.touch(repo);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = storeBranchTip(repo, rest[3]!);
      if (sha === null) return fail(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${rest[3]}`, object: { sha } });
    }
    return fail(404, 'Not Found');
  }

  // -- contents -----------------------------------------------------------------------
  if (rest[0] === 'contents') {
    return routeContents(ctx, repo, rest.slice(1));
  }

  // -- labels ---------------------------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok(
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
      );
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'name is required');
      if (repo.labels.has(name)) return fail(422, `Label '${name}' already exists`);
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color });
    }
    return fail(404, 'Not Found');
  }

  // -- issues ------------------------------------------------------------------------------
  if (rest[0] === 'issues') {
    return routeIssues(ctx, repo, rest.slice(1));
  }

  // -- pull requests -------------------------------------------------------------------------
  if (rest[0] === 'pulls') {
    return routePulls(ctx, repo, rest.slice(1));
  }

  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function routeContents(ctx: RestContext, repo: Repo, pathSegs: string[]): RestReply {
  const method = ctx.method;
  const queryRef = ctx.query.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = resolveRef(repo, queryRef);
    if (tip === null) return fail(404, 'Not Found');
    const treeOid = storeCommitTree(repo, tip);
    if (treeOid === null) return fail(404, 'Not Found');
    if (pathSegs.length === 0) {
      const entries = listDir(repo, treeOid, []);
      if (entries === null) return fail(404, 'Not Found');
      return ok(200, dirEntriesJson(repo, treeOid, entries, ''));
    }
    const found = findPath(repo, treeOid, pathSegs);
    if (!found) return fail(404, 'Not Found');
    const path = pathSegs.join('/');
    if (found.mode === '40000') {
      const entries = listDir(repo, treeOid, pathSegs);
      if (entries === null) return fail(404, 'Not Found');
      return ok(200, dirEntriesJson(repo, treeOid, entries, path));
    }
    const blob = ctx.store.getObject(repo, found.oid);
    if (!blob) return fail(404, 'Not Found');
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: pathSegs[pathSegs.length - 1],
      path,
      content: blob.data.toString('base64'),
      sha: found.oid,
    });
  }

  if (method === 'PUT') {
    if (pathSegs.length === 0) return fail(422, 'path is required');
    const parsed = parseBody(ctx);
    if (parsed.error) return parsed.error;
    const body = parsed.value ?? {};
    const message = typeof body.message === 'string' ? body.message : `Update ${pathSegs.join('/')}`;
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64, 'base64');
    } catch {
      return fail(400, 'content is not valid base64');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = storeBranchTip(repo, branch);
    if (tip === null) {
      const defaultTip = storeBranchTip(repo, repo.defaultBranch);
      if (defaultTip !== null) {
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const treeOid = tip === null ? null : storeCommitTree(repo, tip);
    const current = treeOid === null ? null : findPath(repo, treeOid, pathSegs);
    if (current && current.mode === '40000') return fail(422, 'path is a directory');
    const isUpdate = current !== null;
    if (isUpdate) {
      const wanted = typeof body.sha === 'string' ? body.sha : '';
      if (wanted !== current!.oid) return fail(409, 'sha does not match the current blob');
    }
    const blobOid = ctx.store.putObject(repo, 'blob', bytes);
    const nextTree = putPath(ctx.store, repo, treeOid, pathSegs, blobOid);
    const commitSha = writeCommit(ctx.store, repo, branch, nextTree, message);
    const path = pathSegs.join('/');
    return ok(isUpdate ? 200 : 201, {
      content: {
        name: pathSegs[pathSegs.length - 1],
        path,
        sha: blobOid,
        size: bytes.length,
        encoding: 'base64',
        type: 'file',
      },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    if (pathSegs.length === 0) return fail(422, 'path is required');
    const parsed = parseBody(ctx);
    if (parsed.error) return parsed.error;
    const body = parsed.value ?? {};
    const message = typeof body.message === 'string' ? body.message : `Delete ${pathSegs.join('/')}`;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = storeBranchTip(repo, branch);
    if (tip === null) return fail(404, 'Not Found');
    const treeOid = storeCommitTree(repo, tip);
    if (treeOid === null) return fail(404, 'Not Found');
    const current = findPath(repo, treeOid, pathSegs);
    if (!current || current.mode === '40000') return fail(404, 'Not Found');
    const wanted = typeof body.sha === 'string' ? body.sha : '';
    if (wanted !== current.oid) return fail(409, 'sha does not match the current blob');
    const nextTree = removePath(ctx.store, repo, treeOid, pathSegs);
    if (nextTree === null) return fail(404, 'Not Found');
    const commitSha = writeCommit(ctx.store, repo, branch, nextTree, message);
    return ok(200, { commit: { sha: commitSha, message } });
  }

  return fail(404, 'Not Found');
}

function dirEntriesJson(
  repo: Repo,
  treeOid: string,
  entries: Array<{ mode: string; name: string; oid: string }>,
  prefix: string,
): Array<Record<string, unknown>> {
  void treeOid;
  return entries.map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      return { type: 'dir', name: entry.name, path, sha: entry.oid };
    }
    const blob = repo.objects.get(entry.oid);
    return { type: 'file', name: entry.name, path, sha: entry.oid, size: blob ? blob.data.length : 0 };
  });
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function routeIssues(ctx: RestContext, repo: Repo, rest: string[]): RestReply {
  const method = ctx.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, perPage, link } = paginate(ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.query, list.length);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      return ok(200, pageOf(list, page, perPage).map((issue) => issueJson(repo, issue)), headers);
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return fail(422, 'title is required');
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const labels: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '';
          if (name === '') continue;
          if (!repo.labels.has(name)) return fail(422, `Label '${name}' does not exist`);
          labels.push(name);
        }
      }
      const issue = ctx.store.createIssue(repo, title, bodyText, labels);
      return ok(201, issueJson(repo, issue));
    }
    return fail(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return fail(404, 'Not Found');
  const issue = ctx.store.getIssue(repo, number);
  if (!issue) return fail(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') {
      return { status: 200, body: cachedIssueJson(repo, issue) };
    }
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels: string[] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : '';
          if (name !== '' && repo.labels.has(name)) labels.push(name);
        }
        issue.labels = labels;
      }
      issue.updatedAt = FIXED_ISO_TIME;
      issue.cachedJson = null;
      return ok(200, issueJson(repo, issue));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => commentJson(comment)));
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return fail(422, 'body is required');
      const comment = ctx.store.addComment(issue, text);
      return ok(201, commentJson(comment));
    }
    return fail(405, 'Method Not Allowed');
  }

  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function routePulls(ctx: RestContext, repo: Repo, rest: string[]): RestReply {
  const method = ctx.method;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      list = [...list].sort((a, b) => b.number - a.number);
      const { page, perPage, link } = paginate(ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.query, list.length);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      return ok(200, pageOf(list, page, perPage).map((pull) => pullJson(repo, pull)), headers);
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (parsed.error) return parsed.error;
      const body = parsed.value ?? {};
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') return fail(422, 'title, head and base are required');
      const headSha = storeBranchTip(repo, head);
      const baseSha = storeBranchTip(repo, base);
      if (headSha === null) return fail(422, `head branch '${head}' does not exist`);
      if (baseSha === null) return fail(422, `base branch '${base}' does not exist`);
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const pull = ctx.store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
      const headTree = storeCommitTree(repo, headSha);
      const baseTree = storeCommitTree(repo, baseSha);
      pull.files = headTree !== null && baseTree !== null ? diffTrees(repo, baseTree, headTree) : [];
      pull.mergeable = squashConflicts(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
      return ok(201, pullJson(repo, pull));
    }
    return fail(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) return fail(404, 'Not Found');
  const pull = ctx.store.getPull(repo, number);
  if (!pull) return fail(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullJson(repo, pull));
    return fail(405, 'Method Not Allowed');
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok(200, pull.files);
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return fail(405, 'Method Not Allowed');
    if (pull.merged || pull.state === 'closed') return fail(405, 'Pull request is already merged');
    const headSha = storeBranchTip(repo, pull.headRef);
    const baseSha = storeBranchTip(repo, pull.baseRef);
    if (headSha === null || baseSha === null) return fail(422, 'head or base branch is gone');
    if (squashConflicts(repo, baseSha, headSha)) {
      pull.mergeable = 'CONFLICTING';
      return fail(405, 'Merge conflict');
    }
    const headTree = storeCommitTree(repo, headSha);
    if (headTree === null) return fail(422, 'head has no tree');
    const message = pull.title;
    const squashSha = writeCommit(ctx.store, repo, pull.baseRef, headTree, message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO_TIME;
    pull.mergeSha = squashSha;
    pull.updatedAt = FIXED_ISO_TIME;
    return ok(200, { merged: true, sha: squashSha, message: 'Pull request successfully merged' });
  }

  return fail(404, 'Not Found');
}
