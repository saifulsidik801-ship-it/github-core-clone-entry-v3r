// objects.ts — the git object layer: pkt-line framing, the four object types,
// packfile reading and writing, and the reachability walk every fetch uses.
//
// No I/O here and no store knowledge: these are pure functions over buffers,
// so the fetch and push paths can call them without touching the network.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID, hashObject, isOid } from './seed.ts';

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectKind;
  data: Buffer;
}

/** The pack type codes git assigns to each object kind. */
const KIND_CODE: Record<ObjectKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_KIND: Record<number, ObjectKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's largest pkt-line, header included. */
export const PKT_MAX = 65520;
/** The largest payload a pkt-line can carry. */
export const PKT_PAYLOAD_MAX = PKT_MAX - 4;

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

/** One framed packet: 4 hex length bytes, then the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > PKT_PAYLOAD_MAX) throw new Error(`pkt-line payload ${body.length} exceeds ${PKT_PAYLOAD_MAX}`);
  const head = Buffer.allocUnsafe(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet, `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a whole list of lines / control packets into one buffer. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Decode a complete buffer into packets. A malformed header or a truncated
 * final packet throws; trailing bytes after the last packet throw too, so a
 * corrupt push can never silently pass.
 */
export function depkt(buffer: Buffer): Packet[] {
  const out: Packet[] = [];
  let at = 0;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(at, at + 4).toString('ascii');
    if (!hex4.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      at += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      at += 4;
    } else if (len === 2) {
      out.push({ kind: 'end' });
      at += 4;
    } else if (len < 4 || len > PKT_MAX) {
      throw new Error(`bad pkt-line length ${len}`);
    } else {
      if (at + len > buffer.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buffer.subarray(at + 4, at + len) });
      at += len;
    }
  }
  return out;
}

/** The text of every data packet, in order; control packets are dropped. */
export function packetTexts(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/**
 * Split a buffer at the first flush packet: the packets before it, and the
 * raw bytes after it (a push's packfile, which is not pkt-framed).
 */
export function splitAtFlush(buffer: Buffer): { head: Packet[]; tail: Buffer } {
  const head: Packet[] = [];
  let at = 0;
  const hex4 = /^[0-9a-fA-F]{4}$/;
  while (at < buffer.length) {
    if (at + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const text = buffer.subarray(at, at + 4).toString('ascii');
    if (!hex4.test(text)) throw new Error(`bad pkt-line length ${JSON.stringify(text)}`);
    const len = Number.parseInt(text, 16);
    if (len === 0) return { head, tail: buffer.subarray(at + 4) };
    if (len === 1) {
      head.push({ kind: 'delim' });
      at += 4;
    } else if (len === 2) {
      head.push({ kind: 'end' });
      at += 4;
    } else if (len < 4 || len > PKT_MAX) {
      throw new Error(`bad pkt-line length ${len}`);
    } else {
      if (at + len > buffer.length) throw new Error('truncated pkt-line payload');
      head.push({ kind: 'data', payload: buffer.subarray(at + 4, at + len) });
      at += len;
    }
  }
  return { head, tail: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** git's tree sort: byte order of the name, a directory compared as `name/`. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(at, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    if (!isOid(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. Extra headers are ignored, not rejected. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isOid(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes: tree, parents, author, committer, message. */
export function buildCommit(tree: string, parents: readonly string[], message: string, ident: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjectKind;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as ObjectKind,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(object: string, type: ObjectKind, tag: string, message: string, ident: string): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${ident}\n\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

/** Encode one object's pack header: the type/size varint git uses. */
function packObjectHeader(type: ObjectKind, size: number): Buffer {
  const code = KIND_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas): PACK header, one
 * zlib-deflated entry per object at level 9, then the SHA-1 trailer over
 * everything before it. `objects` is read in the caller's order; callers
 * that need determinism sort first.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 9 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createTrailer(body)]);
}

/** The 20-byte trailer: SHA-1 over every pack byte before it. */
function createTrailer(body: Buffer): Buffer {
  return createHash('sha1').update(body).digest();
}

/** Read one pack entry's size varint at `at`; returns the size and next offset. */
function readPackSize(buffer: Buffer, at: number): { size: number; next: number; first: number } {
  if (at >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[at];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = at + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Read one OFS_DELTA base offset at `at`. */
function readPackOfsBase(buffer: Buffer, at: number): { baseOffset: number; next: number } {
  if (at >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[at];
  let offset = at + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the next offset. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead {
  version: number;
  count: number;
  objects: Map<string, GitObject>;
  checksumOk: boolean;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and
 * REF_DELTA chains. Every object's SHA-1 is recomputed; a mismatch throws,
 * so a corrupt pack can never be stored. `resolveBase` supplies a base a
 * thin pack leaves out (an object the reader already holds).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const trailer = pack.subarray(trailerAt).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerAt)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new Error(`pack trailer ${trailer} does not match its bytes ${computedTrailer}`);

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readPackOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerAt) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_KIND[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerAt), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerAt) throw new Error(`pack has ${trailerAt - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectKind; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { resolved?: { type: ObjectKind; data: Buffer; oid: string } }).resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectKind;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_KIND[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const solved = { type, data, oid };
    (entry as unknown as { resolved?: unknown }).resolved = solved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return solved;
  };
  for (const entry of raw) {
    const solved = resolve(entry);
    if (!objects.has(solved.oid)) objects.set(solved.oid, { type: solved.type, data: solved.data });
  }
  return { version, count, objects, checksumOk };
}

/** Verify a pack's trailer without parsing its objects. */
export function packTrailerOk(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') return false;
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  return trailer === createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** An empty pack: header, zero entries, trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit → tree + parents, tag → its
 * target, tree → entries (gitlinks skipped), blob → nothing. Throws on a
 * missing object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean; stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      // A commit in stopAt is held as a shallow boundary: the caller has the
      // commit and its tree, but NOT its parents. Do not descend past it.
      if (!options.stopAt?.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * True when `ancestor` is reachable from `tip` by following commit parents
 * (a tip is its own ancestor). Bounded, so a pathological chain cannot spin.
 */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (ancestor === tip) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let steps = 0;
  while (queue.length && steps < 100_000) {
    const oid = queue.pop()!;
    steps += 1;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}
