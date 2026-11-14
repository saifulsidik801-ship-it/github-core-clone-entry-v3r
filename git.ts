// git.ts — git smart HTTP: info/refs advertisements (v2 and v0), ls-refs,
// fetch (v2 sections and v0 sideband), and receive-pack pushes with
// report-status.
//
// The fast paths live here too: whole-response caches for advertisements,
// ls-refs and fetches, keyed by the repository's generation, so a repeated
// identical fetch (the clone workload's fifty depth-1 clones) is served from
// bytes built once.

import {
  collectReachable,
  depkt,
  emptyPack,
  packetTexts,
  parseCommit,
  pkt,
  pktFlush,
  pktLines,
  readPack,
  splitAtFlush,
  writePack,
  type GitObject,
  type Packet,
} from './objects.ts';
import { listRefs, listRefsWithHead, peelTarget, validatePushCommand, type PushCommand } from './refs.ts';
import { type Repo, type Store } from './store.ts';
import { ZERO_OID, isOid } from './seed.ts';

const AGENT_NAME = 'github-core-clone/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function reply(status: number, contentType: string, body: Buffer): GitReply {
  return { status, contentType, body };
}

function jsonReply(status: number, value: unknown): GitReply {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8') };
}

/**
 * The capability line a v0 advertisement carries on its first ref, shaped
 * like real git's: upload-pack lists the read capabilities (with the HEAD
 * symref), receive-pack the push capabilities (no HEAD line, no symref —
 * receive-pack never advertises either). Only capabilities the server
 * actually honours are listed.
 */
function v0Caps(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-receive-pack') {
    return `report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 agent=${AGENT_NAME}`;
  }
  return `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress symref=HEAD:refs/heads/main object-format=sha1 agent=${AGENT_NAME}`;
}

/**
 * Build a v0 advertisement body for one service. Smart HTTP frames it as
 * the `# service=` line, a flush, the ref lines (capabilities on the first),
 * then a final flush — exactly the shape git's own http-backend emits.
 */
function buildV0Ad(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = `# service=${service}\n`;
  const caps = v0Caps(service);
  const refs = listRefs(repo);
  const parts: Buffer[] = [pkt(serviceLine), pktFlush()];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let first = true;
    const emit = (oid: string, name: string): void => {
      if (first) {
        parts.push(pkt(`${oid} ${name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pkt(`${oid} ${name}\n`));
      }
    };
    // Upload-pack advertises HEAD (so the client learns the default branch);
    // receive-pack does not advertise HEAD at all.
    if (service === 'git-upload-pack' && head && head !== ZERO_OID) emit(head, 'HEAD');
    for (const ref of refs) {
      emit(ref.oid, ref.name);
      if (ref.peeled) emit(ref.peeled, `${ref.name}^{}`);
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build the v2 capability advertisement (upload-pack only). */
function buildV2Ad(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT_NAME}\n`,
    'fetch=shallow filter\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/**
 * GET /:owner/:repo.git/info/refs?service=... — the advertisement. v2 when
 * the caller asks with Git-Protocol: version=2 on upload-pack, v0 otherwise.
 * A missing repository is 404 and the server stays up.
 */
export function infoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string,
): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonReply(404, { message: 'Not Found' });
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const cached = repo.adCache.get('v2:upload');
    if (cached && cached.gen === repo.generation) return reply(200, UPLOAD_AD, cached.body);
    const body = buildV2Ad();
    repo.adCache.set('v2:upload', { gen: repo.generation, body });
    return reply(200, UPLOAD_AD, body);
  }
  if (service === 'git-upload-pack' || service === 'git-receive-pack') {
    const key = `v0:${service}`;
    const cached = repo.adCache.get(key);
    if (cached && cached.gen === repo.generation) {
      return reply(200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, cached.body);
    }
    const body = buildV0Ad(repo, service);
    repo.adCache.set(key, { gen: repo.generation, body });
    return reply(200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body);
  }
  return jsonReply(400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Answer a v2 ls-refs request from its parsed argument lines. */
function answerLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const key = `ls:${args.prefixes.join('|')}:${args.peel}:${args.symrefs}:${args.unborn}`;
  const cached = repo.lsRefsCache.get(key);
  if (cached && cached.gen === repo.generation) return cached.body;
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const all = listRefsWithHead(repo);
  for (const ref of all) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (args.unborn) lines.push(`unborn ${ref.name} symref-target:${ref.symrefTarget ?? ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    if (args.symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    lines.push(`${line}\n`);
  }
  const parts: Buffer[] = lines.map((line) => pkt(line));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  if (repo.lsRefsCache.size > 200) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(key, { gen: repo.generation, body });
  return body;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** The object set a fetch sends, plus its new shallow boundary information. */
function planFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; ack: string | null } {
  const lookup = (oid: string) => repo.objects.get(oid);
  // Normalize wants: a tag want contributes the tag itself, and its peeled
  // commit is the walk root.
  const roots: string[] = [];
  const extra: string[] = [];
  for (const want of args.wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      extra.push(want);
      roots.push(peelTarget(repo, want));
    } else if (object.type === 'commit') {
      roots.push(want);
    }
  }
  // The depth-limited commit walk: commits at distance < depth from a want,
  // each with its whole tree closure.
  const included = new Set<string>();
  const boundary = new Set<string>();
  if (args.depth !== null) {
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const root of roots) {
      if (!distance.has(root)) {
        distance.set(root, 0);
        queue.push(root);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const dist = distance.get(oid)!;
      if (dist >= args.depth) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      included.add(oid);
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push(parent);
        }
      }
    }
    // Boundary: an included commit with a parent outside the included set.
    for (const oid of included) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent))) boundary.add(oid);
    }
    // Trees and blobs of every included commit.
    for (const oid of [...included]) {
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const reached of collectReachable([parseCommit(object.data).tree], lookup, { allowMissing: true })) {
        included.add(reached);
      }
    }
  } else {
    for (const reached of collectReachable(roots, lookup, { allowMissing: true })) included.add(reached);
  }
  for (const oid of extra) included.add(oid);
  // Subtract everything the caller already holds. The held walk stops at
  // the caller's shallow boundary: a shallow client holds the boundary
  // commit and its tree, but NOT the boundary's parents, so those parents
  // must still be sent on a deepen.
  const held = collectReachable(args.haves, lookup, { allowMissing: true, stopAt: new Set(args.shallow) });
  const send = new Set<string>();
  for (const oid of included) if (!held.has(oid)) send.add(oid);
  // Unshallow: an old boundary whose parents are all included now.
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const old of args.shallow) {
      if (!included.has(old)) continue;
      const object = lookup(old);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => included.has(parent))) unshallow.push(old);
    }
  }
  // ACK the first have that is an ancestor-or-equal of a want (the v0 fetch
  // response reports it; the v2 response never carries acknowledgments).
  let ack: string | null = null;
  if (args.haves.length > 0) {
    const wantClosure = collectReachable(roots, lookup, { allowMissing: true });
    for (const have of args.haves) {
      if (wantClosure.has(have)) {
        ack = have;
        break;
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: [...boundary].sort(), unshallow, ack };
}

/** One sideband packet: a band byte plus up to 60,000 bytes of pack data. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 60000;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pkt(Buffer.concat([Buffer.from([1]), pack])));
  return out;
}

/**
 * The v2 fetch response, shaped the way real servers shape it: a section
 * appears only when it has something to say. A request that already sent
 * `done` gets no acknowledgments section; shallow-info appears only when a
 * boundary moved; wanted-refs is never sent (no client here asks by ref
 * name). The packfile section is always last, then a flush.
 */
function buildV2Fetch(plan: ReturnType<typeof planFetch>): Buffer {
  const pack = plan.objects.length > 0 ? writePack(plan.objects) : emptyPack();
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, sideband pack. */
function buildV0Fetch(args: FetchArgs, plan: ReturnType<typeof planFetch>): Buffer {
  const pack = plan.objects.length > 0 ? writePack(plan.objects) : emptyPack();
  const parts: Buffer[] = [];
  if (plan.ack) parts.push(pkt(`ACK ${plan.ack}\n`));
  else parts.push(pkt('NAK\n'));
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchCacheKey(version: 2 | 0, args: FetchArgs): string {
  const sorted = (list: readonly string[]): string => [...list].sort().join(',');
  return `fetch:v${version}|w:${sorted(args.wants)}|h:${sorted(args.haves)}|s:${sorted(args.shallow)}|d:${args.depth ?? ''}`;
}

/**
 * POST /:owner/:repo.git/git-upload-pack — ls-refs or fetch, v2 when the
 * caller asked with Git-Protocol: version=2, v0 otherwise. A malformed body
 * answers 400 and the server stays up.
 */
export function uploadPack(
  store: Store,
  owner: string,
  repoName: string,
  gitProtocol: string,
  body: Buffer,
): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonReply(404, { message: 'Not Found' });
  let packets: Packet[];
  try {
    packets = depkt(body);
  } catch {
    return jsonReply(400, { message: 'malformed pkt-line stream' });
  }
  const lines = packetTexts(packets);
  if (gitProtocol === 'version=2') {
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text === 'unborn') args.unborn = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
      }
      return reply(200, UPLOAD_RESULT, answerLsRefs(repo, args));
    }
    if (command === 'command=fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) {
          const n = Number.parseInt(text.slice(7).trim(), 10);
          if (Number.isFinite(n)) args.depth = n;
        }
      }
      const key = fetchCacheKey(2, args);
      const cached = repo.fetchCache.get(key);
      if (cached && cached.gen === repo.generation) return reply(200, UPLOAD_RESULT, cached.body);
      const plan = planFetch(repo, args);
      const out = buildV2Fetch(plan);
      if (repo.fetchCache.size > 200) repo.fetchCache.clear();
      repo.fetchCache.set(key, { gen: repo.generation, body: out });
      return reply(200, UPLOAD_RESULT, out);
    }
    return jsonReply(400, { message: `unknown v2 command ${JSON.stringify(command)}` });
  }
  // Protocol v0: want/have lines in two sections, split by the flush packet.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      const oid = rest.split(' ')[0]!;
      if (isOid(oid)) args.wants.push(oid);
    } else if (text.startsWith('have ')) {
      args.haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      args.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  const key = fetchCacheKey(0, args);
  const cached = repo.fetchCache.get(key);
  if (cached && cached.gen === repo.generation) return reply(200, UPLOAD_RESULT, cached.body);
  const plan = planFetch(repo, args);
  const out = buildV0Fetch(args, plan);
  if (repo.fetchCache.size > 200) repo.fetchCache.clear();
  repo.fetchCache.set(key, { gen: repo.generation, body: out });
  return reply(200, UPLOAD_RESULT, out);
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

/**
 * POST /:owner/:repo.git/git-receive-pack — a v0 command list plus a pack.
 * Objects unpack first; each ref is then validated (fast-forward only) and
 * applied or refused per ref, with a sideband report-status answer.
 */
export function receivePack(store: Store, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonReply(404, { message: 'Not Found' });
  let head: Packet[];
  let packBytes: Buffer;
  try {
    const split = splitAtFlush(body);
    head = split.head;
    packBytes = split.tail;
  } catch {
    return jsonReply(400, { message: 'malformed pkt-line stream' });
  }
  const commands: PushCommand[] = [];
  for (const packet of head) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  const reportLines: string[] = [];
  if (commands.length === 0) {
    reportLines.push('unpack ok');
  } else {
    let unpackDetail: string | null = null;
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackDetail = (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 120);
      }
    }
    if (unpackDetail !== null) {
      reportLines.push(`unpack ${unpackDetail}`);
    } else {
      reportLines.push('unpack ok');
      let moved = false;
      for (const command of commands) {
        const verdict = validatePushCommand(repo, command);
        if (verdict.ok) {
          if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
          else repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
          moved = true;
        } else {
          reportLines.push(`ng ${command.ref} ${verdict.reason}`);
        }
      }
      if (moved) store.touch(repo);
      else if (packBytes.length > 0) store.touch(repo);
    }
  }
  // The report is itself pkt-lined, carried in band 1 of the sideband.
  const inner = pktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  const framed = pkt(Buffer.concat([Buffer.from([1]), inner]));
  return reply(200, RECEIVE_RESULT, Buffer.concat([framed, pktFlush()]));
}
