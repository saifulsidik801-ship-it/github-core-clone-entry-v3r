// main.ts — the entrypoint: one process, one HTTP server, four surfaces.
//
// Lifecycle: bind a port (ephemeral unless PORT says otherwise, never 8080),
// register it with the env at $MAKEFUN_ENV_URL, then poll /done until the
// suite says the trial is over and exit 0. Without an env URL there is
// nothing to register with, so the server just serves (local practice runs).
//
// Routing is by hand, hottest first: the two timed REST workloads (GET one
// issue, POST one issue) take a fast path straight to the store, everything
// else falls through to the REST, GraphQL, MCP and git handlers. Every
// request except GET /healthz needs a Bearer token; a missing one is 401.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { cachedIssueJson, issueJson, routeRest } from './rest.ts';
import { Store } from './store.ts';
import { VIEWER_LOGIN, nextRequestId } from './seed.ts';

const store = new Store();

/** Read a request body whole, as bytes. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function hasBearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && header.slice(7).trim() !== '';
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer, extra?: Record<string, string>): void {
  const headers: Record<string, string> = { 'content-type': contentType, ...extra };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  send(res, status, 'application/json', JSON.stringify(value), extra);
}

/** The request id every REST reply carries. */
function requestIdHeader(): Record<string, string> {
  return { 'X-GitHub-Request-Id': nextRequestId() };
}

// ---------------------------------------------------------------------------
// fast paths (the two timed REST workloads)
// ---------------------------------------------------------------------------

/**
 * GET /api/v3/repos/{owner}/{repo}/issues/{number} with no query string:
 * straight to the store and the issue's cached JSON. Anything shaped
 * differently falls through to the generic router.
 */
function fastGetIssue(res: ServerResponse, segments: string[]): boolean {
  // segments: ['api','v3','repos', owner, repo, 'issues', number]
  if (segments.length !== 7 || segments[5] !== 'issues') return false;
  const owner = segments[3]!;
  const repoName = segments[4]!;
  const number = Number.parseInt(segments[6]!, 10);
  if (owner !== VIEWER_LOGIN || !Number.isSafeInteger(number) || number <= 0) return false;
  const repo = store.getRepo(owner, repoName);
  if (!repo) return false;
  const issue = store.getIssue(repo, number);
  if (!issue) return false;
  send(res, 200, 'application/json', cachedIssueJson(repo, issue), requestIdHeader());
  return true;
}

/**
 * POST /api/v3/repos/{owner}/{repo}/issues: parse the small JSON body,
 * validate the title and labels the way the generic route does, create the
 * issue and answer. Anything shaped differently falls through.
 */
async function fastPostIssue(req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<boolean> {
  // segments: ['api','v3','repos', owner, repo, 'issues']
  if (segments.length !== 6 || segments[5] !== 'issues') return false;
  const owner = segments[3]!;
  const repoName = segments[4]!;
  if (owner !== VIEWER_LOGIN) return false;
  const repo = store.getRepo(owner, repoName);
  if (!repo) return false;
  const raw = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'malformed JSON body' }, requestIdHeader());
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { message: 'request body must be a JSON object' }, requestIdHeader());
    return true;
  }
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  if (title === '') {
    sendJson(res, 422, { message: 'title is required' }, requestIdHeader());
    return true;
  }
  const labels: string[] = [];
  if (Array.isArray(parsed.labels)) {
    for (const entry of parsed.labels) {
      const name =
        typeof entry === 'string'
          ? entry
          : typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
            ? (entry as { name: string }).name
            : '';
      if (name === '') continue;
      if (!repo.labels.has(name)) {
        sendJson(res, 422, { message: `Label '${name}' does not exist` }, requestIdHeader());
        return true;
      }
      labels.push(name);
    }
  }
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  const issue = store.createIssue(repo, title, body, labels);
  sendJson(res, 201, issueJson(repo, issue), requestIdHeader());
  return true;
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const cut = rawUrl.indexOf('?');
    const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
    const queryString = cut < 0 ? '' : rawUrl.slice(cut + 1);

    // The boot probe: no auth, always 200.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!hasBearer(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, requestIdHeader());
      return;
    }

    const segments = path.split('/').filter((part) => part !== '');

    // -- REST v3 ---------------------------------------------------------------
    if (segments[0] === 'api' && segments[1] === 'v3') {
      // Fast paths for the two timed workloads.
      if (method === 'GET' && queryString === '') {
        if (fastGetIssue(res, segments)) return;
      }
      if (method === 'POST') {
        if (await fastPostIssue(req, res, segments)) return;
      }
      const bodyText = method === 'GET' || method === 'HEAD' ? '' : (await readBody(req)).toString('utf8');
      const query = new URLSearchParams(queryString);
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      const answer = routeRest({
        store,
        method,
        segments: segments.slice(2),
        query,
        origin,
        bodyText,
      });
      send(res, answer.status, 'application/json', answer.body, {
        ...requestIdHeader(),
        ...answer.headers,
      });
      return;
    }

    // -- GraphQL -----------------------------------------------------------------
    if (path === '/api/graphql' && method === 'POST') {
      const text = (await readBody(req)).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        sendJson(res, 400, { message: 'malformed JSON body' }, requestIdHeader());
        return;
      }
      send(res, 200, 'application/json', handleGraphQL(store, parsed), requestIdHeader());
      return;
    }

    // -- MCP -----------------------------------------------------------------------
    if (path === '/mcp') {
      if (method === 'DELETE') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, requestIdHeader());
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, requestIdHeader());
        return;
      }
      const text = (await readBody(req)).toString('utf8');
      const answer = handleMcp(store, text, true);
      send(res, answer.status, 'application/json', answer.body, requestIdHeader());
      return;
    }

    // -- git smart HTTP ---------------------------------------------------------------
    if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
      const owner = segments[0]!;
      const repoName = segments[1].slice(0, -4);
      const tail = segments.slice(2);
      const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : '';
      if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
        const service = new URLSearchParams(queryString).get('service') ?? '';
        const answer = infoRefs(store, owner, repoName, service, gitProtocol);
        send(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
        const body = await readBody(req);
        const answer = uploadPack(store, owner, repoName, gitProtocol, body);
        send(res, answer.status, answer.contentType, answer.body);
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
        const body = await readBody(req);
        const answer = receivePack(store, owner, repoName, body);
        send(res, answer.status, answer.contentType, answer.body);
        return;
      }
    }

    sendJson(res, 404, { message: 'Not Found' }, requestIdHeader());
  } catch (err) {
    try {
      sendJson(res, 500, { message: (err as Error).message }, requestIdHeader());
    } catch {
      // The socket is already gone; nothing left to do.
    }
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** POST the bound port until the env accepts it; 409 means a first register won. */
async function register(envUrl: string, port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(Math.min(2_000, 250 * 2 ** Math.min(attempt, 8)));
    attempt += 1;
  }
}

/** Poll GET /done until the env says the trial is over. */
async function waitDone(envUrl: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 200) {
        const parsed = (await res.json()) as unknown;
        if (parsed !== null && typeof parsed === 'object' && (parsed as { done?: unknown }).done === true) return;
      }
    } catch {
      // A failed poll is retried; the env may still be starting.
    }
    await sleep(Math.min(2_000, 250 * 2 ** Math.min(attempt, 8)));
    attempt += 1;
  }
}

async function main(): Promise<void> {
  const wantedPort = Number.parseInt(process.env.PORT ?? '', 10);
  const port = Number.isSafeInteger(wantedPort) && wantedPort > 0 && wantedPort !== 8080 ? wantedPort : 0;
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : 0;
  process.stderr.write(`[entry] listening on http://127.0.0.1:${bound}\n`);

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    // No env to talk to (a local practice run): serve until killed.
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: serving without registering\n');
    return;
  }
  await register(envUrl, bound);
  process.stderr.write('[entry] registered\n');
  await waitDone(envUrl);
  process.stderr.write('[entry] done\n');
  server.close();
  process.exit(0);
}

void main().catch((err: unknown) => {
  process.stderr.write(`[entry] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
