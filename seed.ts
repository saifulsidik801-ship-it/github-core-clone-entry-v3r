// seed.ts — the fixed facts this forge is built on.
//
// Everything a trial can observe is deterministic: one viewer identity, one
// fixed timestamp for every date the API serves, one fixed commit timestamp
// for every commit the server itself writes. Nothing here reads a clock, a
// random source, or the environment at request time, so two fresh servers fed
// the same request sequence answer byte for byte alike.

import { createHash } from 'node:crypto';

/** The login the bearer token names. The suite's scenario fixes this identity. */
export const VIEWER_LOGIN = 'adaiversen';

/** The viewer as the REST and GraphQL surfaces describe them. */
export const VIEWER_ID = 1;
export const VIEWER_EMAIL = 'adaiversen@users.noreply.github.com';
export const VIEWER_NAME = 'adaiversen';

/** The one timestamp every served date carries. */
export const FIXED_ISO_TIME = '2024-01-01T00:00:00Z';

/** Unix seconds stamped into every commit this server writes itself. */
export const FIXED_COMMIT_SECONDS = 1_700_000_000;

/** The ident line on server-written commits and tags. */
export const SERVER_IDENT = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_COMMIT_SECONDS} +0000`;

/** The branch a fresh repository points its HEAD at. */
export const DEFAULT_BRANCH = 'main';

/** The all-zero object id: an unborn ref, a create's old value, a delete's new value. */
export const ZERO_OID = '0'.repeat(40);

/** A 40-hex object id, lowercase, the only id form this forge accepts. */
const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

/** SHA-1 over git's `<type> <size>\0` header plus the object's bytes. */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** The loose-object bytes (header + content) a SHA-1 is computed over. */
export function looseBytes(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

/** Base64 of a UTF-8 string. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** UTF-8 string back out of base64, or null when the input is not base64. */
export function b64decode(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return null;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** An opaque global id: base64 of `Kind:rest`, never the plain database id. */
export function globalId(kind: string, rest: string): string {
  return b64encode(`${kind}:${rest}`);
}

/** Split a global id back into its kind and rest, or null when it is not one. */
export function splitGlobalId(id: string): { kind: string; rest: string } | null {
  const plain = b64decode(id);
  if (plain === null) return null;
  const cut = plain.indexOf(':');
  if (cut <= 0) return null;
  return { kind: plain.slice(0, cut), rest: plain.slice(cut + 1) };
}

/** Escape a string for safe embedding inside a JSON string literal. */
export function jsonEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** A monotonically increasing request counter, the source of X-GitHub-Request-Id. */
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Compare two strings by UTF-8 byte order (git's ordering for names). */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
