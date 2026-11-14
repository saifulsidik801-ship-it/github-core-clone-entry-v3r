// gql.ts — the GraphQL v4 surface at /api/graphql.
//
// A small dependency-free document parser (operations, fragments, variables,
// inline fragments) plus resolvers over the same store REST uses. Global ids
// are opaque base64; an unknown repository answers data.repository = null
// with no errors; an unknown field answers HTTP 200 with an errors array
// naming it; a batched array body answers an array of results in order.

import { diffTrees, squashConflicts } from './refs.ts';
import {
  branchTip,
  commentGlobalId,
  commitTree,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  writeCommit,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { FIXED_ISO_TIME, VIEWER_LOGIN, globalId, splitGlobalId } from './seed.ts';

// ---------------------------------------------------------------------------
// document parsing
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias: string;
  args: Array<{ name: string; value: Value }>;
  children: FieldNode[];
  /** The type an inline fragment applies to, or null for a plain field. */
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: FieldNode[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  text: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread', text: '...' });
      at += 3;
      continue;
    }
    if ('{}():$!@=[]|&'.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(at, at + 3) === '"""') {
        const end = source.indexOf('"""', at + 3);
        const raw = end < 0 ? source.slice(at + 3) : source.slice(at + 3, end);
        tokens.push({ kind: 'string', text: raw });
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      let out = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const esc = source[at + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          at += 2;
        } else {
          out += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', text: out });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let end = at;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      let isFloat = false;
      if (source[end] === '.' && /[0-9]/.test(source[end + 1] ?? '')) {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', text: source.slice(at, end) });
      at = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = at;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', text: source.slice(at, end) });
      at = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.at += 1;
    return token;
  }

  private expect(text: string): void {
    const token = this.next();
    if (token.text !== text) throw new Error(`expected ${JSON.stringify(text)}, got ${JSON.stringify(token.text)}`);
  }

  private eat(text: string): boolean {
    if (this.peek()?.text === text) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    const fragments = new Map<string, FieldNode[]>();
    while (this.at < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.text === 'fragment') {
        this.next();
        const name = this.next().text;
        this.next(); // 'on'
        const typeName = this.next().text;
        void typeName;
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (token.kind === 'name' && (token.text === 'query' || token.text === 'mutation')) {
        kind = token.text as 'query' | 'mutation';
        this.next();
        const maybeName = this.peek();
        if (maybeName?.kind === 'name') {
          name = maybeName.text;
          this.next();
        }
      }
      // Variable definitions and directives: parsed loosely and skipped.
      if (this.peek()?.text === '(') this.skipBalanced('(', ')');
      while (this.peek()?.text === '@') {
        this.next();
        this.next();
        if (this.peek()?.text === '(') this.skipBalanced('(', ')');
      }
      const fields = this.parseSelectionSet();
      operations.push({ kind, name, fields });
    }
    // Inline named fragment spreads.
    const expand = (fields: FieldNode[]): FieldNode[] => {
      const out: FieldNode[] = [];
      for (const field of fields) {
        if (field.name === '...spread') {
          const target = fragments.get(field.alias);
          if (target) out.push(...expand(target));
          continue;
        }
        out.push({ ...field, children: expand(field.children) });
      }
      return out;
    };
    for (const operation of operations) operation.fields = expand(operation.fields);
    return operations;
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.text === open) depth += 1;
      else if (token.text === close) depth -= 1;
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek()?.text !== '}') {
      if (this.peek()?.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.text === 'on') {
          this.next();
          const typeName = this.next().text;
          const children = this.parseSelectionSet();
          for (const child of children) fields.push({ ...child, fragmentType: typeName });
        } else if (next?.kind === 'name') {
          const name = this.next().text;
          fields.push({ name: '...spread', alias: name, args: [], children: [], fragmentType: null });
          while (this.peek()?.text === '@') {
            this.next();
            this.next();
            if (this.peek()?.text === '(') this.skipBalanced('(', ')');
          }
        } else {
          const children = this.parseSelectionSet();
          fields.push(...children);
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    let name = this.next().text;
    let alias = name;
    if (this.peek()?.text === ':') {
      this.next();
      alias = name;
      name = this.next().text;
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek()?.text === '(') {
      this.next();
      while (this.peek()?.text !== ')') {
        const argName = this.next().text;
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek()?.text === '@') {
      this.next();
      this.next();
      if (this.peek()?.text === '(') this.skipBalanced('(', ')');
    }
    let children: FieldNode[] = [];
    if (this.peek()?.text === '{') children = this.parseSelectionSet();
    return { name, alias, args, children, fragmentType: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.text === '$') {
      return { kind: 'variable', name: this.next().text };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.text };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.text, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.text) };
    if (token.text === '[') {
      const values: Value[] = [];
      while (this.peek()?.text !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.text === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek()?.text !== '}') {
        const name = this.next().text;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.text === 'true') return { kind: 'boolean', value: true };
    if (token.text === 'false') return { kind: 'boolean', value: false };
    if (token.text === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.text };
  }
}

/** Turn a parsed argument value into a plain JS value, resolving variables. */
function materialize(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => materialize(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = materialize(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = materialize(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// the schema's field sets (for unknown-field errors)
// ---------------------------------------------------------------------------

const FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  User: new Set(['login', 'id', 'name', 'email']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'createdAt', 'updatedAt', 'issue',
    'issues', 'pullRequests', 'pullRequest', 'url',
  ]),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequest: new Set([
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt',
  ]),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PullRequestFileConnection: new Set(['nodes', 'edges', 'pageInfo']),
  PullRequestFile: new Set(['path', 'additions', 'deletions', 'changes', 'status']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  IssueComment: new Set(['id', 'body', 'createdAt', 'author']),
  IssueCommentConnection: new Set(['nodes', 'edges', 'pageInfo']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  Label: new Set(['name', 'color']),
  LabelConnection: new Set(['nodes', 'edges', 'pageInfo']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  AddCommentEdge: new Set(['node', 'cursor']),
  __Type: new Set(['name', 'kind', 'description', 'fields', 'enumValues']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __EnumValue: new Set(['name', 'description']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
  __Schema: new Set(['queryType', 'mutationType', 'subscriptionType', 'types', 'directives']),
};

class UnknownField extends Error {
  field: string;
  typeName: string;

  constructor(field: string, typeName: string) {
    super(`Cannot query field "${field}" on type "${typeName}".`);
    this.field = field;
    this.typeName = typeName;
  }
}

function checkField(typeName: string, field: FieldNode): void {
  if (field.name === '__typename') return;
  const known = FIELDS[typeName];
  if (known && !known.has(field.name)) throw new UnknownField(field.name, typeName);
}

// ---------------------------------------------------------------------------
// introspection data
// ---------------------------------------------------------------------------

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'], enumValues: [] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt'], enumValues: [] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'], enumValues: [] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'], enumValues: [] },
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'], enumValues: [] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function typeInfo(name: string, children: FieldNode[]): Record<string, unknown> {
  const info = TYPE_INFO[name];
  const out: Record<string, unknown> = { name, kind: info?.kind ?? 'OBJECT', description: null };
  for (const child of children) {
    if (child.name === '__typename') {
      out.__typename = '__Type';
    } else if (child.name === 'fields') {
      out.fields = (info?.fields ?? []).map((field) => ({
        name: field,
        description: null,
        args: [],
        type: { name: 'String', kind: 'SCALAR' },
      }));
    } else if (child.name === 'enumValues') {
      out.enumValues = (info?.enumValues ?? []).map((value) => ({ name: value, description: null }));
    } else if (child.name === 'name') {
      out.name = name;
    } else if (child.name === 'kind') {
      out.kind = info?.kind ?? 'OBJECT';
    } else if (child.name === 'description') {
      out.description = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// cursors and connections
// ---------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return globalId('cursor', String(number));
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const split = splitGlobalId(cursor);
  if (!split || split.kind !== 'cursor') return null;
  const n = Number.parseInt(split.rest, 10);
  return Number.isSafeInteger(n) ? n : null;
}

interface ConnectionSlice<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Slice a number-ordered list into one connection page. */
function paginateByNumber<T extends { number: number }>(
  items: readonly T[],
  first: unknown,
  after: unknown,
  descending: boolean,
): ConnectionSlice<T> {
  const ordered = [...items].sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const afterNumber = decodeCursor(after);
  let start = 0;
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => item.number === afterNumber);
    start = index < 0 ? 0 : index + 1;
  }
  const size = typeof first === 'number' && first > 0 ? Math.trunc(first) : ordered.length;
  const page = ordered.slice(start, start + size);
  return {
    nodes: page,
    hasNextPage: start + page.length < ordered.length,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null,
  };
}

// ---------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

function resolveUser(children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('User', child);
    if (child.name === '__typename') out[child.alias] = 'User';
    else if (child.name === 'login') out[child.alias] = VIEWER_LOGIN;
    else if (child.name === 'id') out[child.alias] = '1';
    else if (child.name === 'name') out[child.alias] = VIEWER_LOGIN;
    else if (child.name === 'email') out[child.alias] = `${VIEWER_LOGIN}@users.noreply.github.com`;
  }
  return out;
}

function resolveRefName(name: string, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('Ref', child);
    if (child.name === '__typename') out[child.alias] = 'Ref';
    else if (child.name === 'name') out[child.alias] = name;
  }
  return out;
}

function resolveIssue(ctx: Ctx, repo: Repo, issue: Issue, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('Issue', child);
    switch (child.name) {
      case '__typename':
        out[child.alias] = 'Issue';
        break;
      case 'id':
        out[child.alias] = issueGlobalId(repo, issue);
        break;
      case 'number':
        out[child.alias] = issue.number;
        break;
      case 'title':
        out[child.alias] = issue.title;
        break;
      case 'body':
        out[child.alias] = issue.body;
        break;
      case 'state':
        out[child.alias] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'createdAt':
        out[child.alias] = issue.createdAt;
        break;
      case 'updatedAt':
        out[child.alias] = issue.updatedAt;
        break;
      case 'author':
        out[child.alias] = resolveUser(child.children);
        break;
      case 'labels': {
        const nodes = issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' }));
        out[child.alias] = resolveLabelConnection(nodes, child.children);
        break;
      }
      case 'comments': {
        const nodes = issue.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt }));
        out[child.alias] = resolveCommentConnection(ctx, repo, issue, nodes, child.children);
        break;
      }
    }
  }
  return out;
}

function resolveLabelConnection(
  nodes: Array<{ name: string; color: string }>,
  children: FieldNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('LabelConnection', child);
    if (child.name === 'nodes') {
      out[child.alias] = nodes.map((node) => {
        const entry: Record<string, unknown> = {};
        for (const sub of child.children) {
          checkField('Label', sub);
          if (sub.name === '__typename') entry[sub.alias] = 'Label';
          else if (sub.name === 'name') entry[sub.alias] = node.name;
          else if (sub.name === 'color') entry[sub.alias] = node.color;
        }
        return entry;
      });
    } else if (child.name === 'totalCount') {
      out[child.alias] = nodes.length;
    } else if (child.name === 'pageInfo') {
      out[child.alias] = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
    }
  }
  return out;
}

function resolveCommentConnection(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
  nodes: Array<{ id: number; body: string; createdAt: string }>,
  children: FieldNode[],
): Record<string, unknown> {
  void ctx;
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('IssueCommentConnection', child);
    if (child.name === 'nodes') {
      out[child.alias] = nodes.map((node) => {
        const entry: Record<string, unknown> = {};
        for (const sub of child.children) {
          checkField('IssueComment', sub);
          if (sub.name === '__typename') entry[sub.alias] = 'IssueComment';
          else if (sub.name === 'id') entry[sub.alias] = commentGlobalId(repo, issue, { id: node.id, body: node.body, createdAt: node.createdAt });
          else if (sub.name === 'body') entry[sub.alias] = node.body;
          else if (sub.name === 'createdAt') entry[sub.alias] = node.createdAt;
          else if (sub.name === 'author') entry[sub.alias] = resolveUser(sub.children);
        }
        return entry;
      });
    } else if (child.name === 'pageInfo') {
      out[child.alias] = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
    }
  }
  return out;
}

function resolveIssueConnection(
  ctx: Ctx,
  repo: Repo,
  issues: readonly Issue[],
  args: Record<string, unknown>,
  children: FieldNode[],
): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let filtered = [...issues];
  if (states) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    filtered = filtered.filter((issue) => wanted.has(issue.state));
  }
  let descending = false;
  if (args.orderBy !== null && typeof args.orderBy === 'object') {
    const orderBy = args.orderBy as Record<string, unknown>;
    descending = String(orderBy.direction ?? '').toUpperCase() === 'DESC';
  }
  const slice = paginateByNumber(filtered, args.first, args.after, descending);
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('IssueConnection', child);
    if (child.name === 'nodes') {
      out[child.alias] = slice.nodes.map((issue) => resolveIssue(ctx, repo, issue, child.children));
    } else if (child.name === 'edges') {
      out[child.alias] = slice.nodes.map((issue) => {
        const entry: Record<string, unknown> = {};
        for (const sub of child.children) {
          checkField('IssueEdge', sub);
          if (sub.name === 'node') entry[sub.alias] = resolveIssue(ctx, repo, issue, sub.children);
          else if (sub.name === 'cursor') entry[sub.alias] = encodeCursor(issue.number);
        }
        return entry;
      });
    } else if (child.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const sub of child.children) {
        checkField('PageInfo', sub);
        if (sub.name === 'hasNextPage') info[sub.alias] = slice.hasNextPage;
        else if (sub.name === 'hasPreviousPage') info[sub.alias] = false;
        else if (sub.name === 'endCursor') info[sub.alias] = slice.endCursor;
        else if (sub.name === 'startCursor') info[sub.alias] = slice.nodes.length > 0 ? encodeCursor(slice.nodes[0]!.number) : null;
      }
      out[child.alias] = info;
    } else if (child.name === 'totalCount') {
      out[child.alias] = filtered.length;
    }
  }
  return out;
}

function resolvePull(ctx: Ctx, repo: Repo, pull: PullRequest, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('PullRequest', child);
    switch (child.name) {
      case '__typename':
        out[child.alias] = 'PullRequest';
        break;
      case 'id':
        out[child.alias] = pullGlobalId(repo, pull);
        break;
      case 'number':
        out[child.alias] = pull.number;
        break;
      case 'title':
        out[child.alias] = pull.title;
        break;
      case 'body':
        out[child.alias] = pull.body;
        break;
      case 'state':
        out[child.alias] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        break;
      case 'merged':
        out[child.alias] = pull.merged;
        break;
      case 'mergeable':
        out[child.alias] = pull.mergeable;
        break;
      case 'headRefName':
        out[child.alias] = pull.headRef;
        break;
      case 'baseRefName':
        out[child.alias] = pull.baseRef;
        break;
      case 'headRef':
        out[child.alias] = resolveRefName(pull.headRef, child.children);
        break;
      case 'baseRef':
        out[child.alias] = resolveRefName(pull.baseRef, child.children);
        break;
      case 'createdAt':
        out[child.alias] = pull.createdAt;
        break;
      case 'updatedAt':
        out[child.alias] = pull.updatedAt;
        break;
      case 'files': {
        const args = argMap(child, ctx.variables);
        const first = typeof args.first === 'number' ? args.first : pull.files.length;
        const nodes = pull.files.slice(0, first);
        const conn: Record<string, unknown> = {};
        for (const sub of child.children) {
          checkField('PullRequestFileConnection', sub);
          if (sub.name === 'nodes') {
            conn[sub.alias] = nodes.map((file) => {
              const entry: Record<string, unknown> = {};
              for (const leaf of sub.children) {
                checkField('PullRequestFile', leaf);
                if (leaf.name === '__typename') entry[leaf.alias] = 'PullRequestFile';
                else if (leaf.name === 'path') entry[leaf.alias] = file.filename;
                else if (leaf.name === 'additions') entry[leaf.alias] = file.additions;
                else if (leaf.name === 'deletions') entry[leaf.alias] = file.deletions;
                else if (leaf.name === 'changes') entry[leaf.alias] = file.changes;
                else if (leaf.name === 'status') entry[leaf.alias] = file.status.toUpperCase();
              }
              return entry;
            });
          } else if (sub.name === 'pageInfo') {
            conn[sub.alias] = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
          }
        }
        out[child.alias] = conn;
        break;
      }
    }
  }
  return out;
}

function resolvePullConnection(
  ctx: Ctx,
  repo: Repo,
  pulls: readonly PullRequest[],
  args: Record<string, unknown>,
  children: FieldNode[],
): Record<string, unknown> {
  const slice = paginateByNumber(pulls, args.first, args.after, false);
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('PullRequestConnection', child);
    if (child.name === 'nodes') {
      out[child.alias] = slice.nodes.map((pull) => resolvePull(ctx, repo, pull, child.children));
    } else if (child.name === 'edges') {
      out[child.alias] = slice.nodes.map((pull) => {
        const entry: Record<string, unknown> = {};
        for (const sub of child.children) {
          checkField('PullRequestEdge', sub);
          if (sub.name === 'node') entry[sub.alias] = resolvePull(ctx, repo, pull, sub.children);
          else if (sub.name === 'cursor') entry[sub.alias] = encodeCursor(pull.number);
        }
        return entry;
      });
    } else if (child.name === 'pageInfo') {
      const info: Record<string, unknown> = {};
      for (const sub of child.children) {
        checkField('PageInfo', sub);
        if (sub.name === 'hasNextPage') info[sub.alias] = slice.hasNextPage;
        else if (sub.name === 'hasPreviousPage') info[sub.alias] = false;
        else if (sub.name === 'endCursor') info[sub.alias] = slice.endCursor;
        else if (sub.name === 'startCursor') info[sub.alias] = slice.nodes.length > 0 ? encodeCursor(slice.nodes[0]!.number) : null;
      }
      out[child.alias] = info;
    } else if (child.name === 'totalCount') {
      out[child.alias] = pulls.length;
    }
  }
  return out;
}

function resolveRepository(ctx: Ctx, repo: Repo, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('Repository', child);
    switch (child.name) {
      case '__typename':
        out[child.alias] = 'Repository';
        break;
      case 'id':
        out[child.alias] = repoGlobalId(repo);
        break;
      case 'databaseId':
        out[child.alias] = repo.id;
        break;
      case 'name':
        out[child.alias] = repo.name;
        break;
      case 'nameWithOwner':
        out[child.alias] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[child.alias] = resolveUser(child.children);
        break;
      case 'description':
        out[child.alias] = repo.description;
        break;
      case 'defaultBranchRef':
        out[child.alias] = resolveRefName(repo.defaultBranch, child.children);
        break;
      case 'viewerPermission':
        out[child.alias] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[child.alias] = true;
        break;
      case 'isPrivate':
        out[child.alias] = repo.isPrivate;
        break;
      case 'createdAt':
        out[child.alias] = repo.createdAt;
        break;
      case 'updatedAt':
        out[child.alias] = repo.createdAt;
        break;
      case 'url':
        out[child.alias] = `https://github.com/${repo.owner}/${repo.name}`;
        break;
      case 'issue': {
        const args = argMap(child, ctx.variables);
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = ctx.store.getIssue(repo, number);
        out[child.alias] = issue ? resolveIssue(ctx, repo, issue, child.children) : null;
        break;
      }
      case 'issues': {
        const args = argMap(child, ctx.variables);
        out[child.alias] = resolveIssueConnection(ctx, repo, repo.issues, args, child.children);
        break;
      }
      case 'pullRequests': {
        const args = argMap(child, ctx.variables);
        out[child.alias] = resolvePullConnection(ctx, repo, repo.pulls, args, child.children);
        break;
      }
      case 'pullRequest': {
        const args = argMap(child, ctx.variables);
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = ctx.store.getPull(repo, number);
        out[child.alias] = pull ? resolvePull(ctx, repo, pull, child.children) : null;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function findRepoByGlobalId(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const split = splitGlobalId(id);
  if (!split || split.kind !== 'Repository') return null;
  const dbId = Number.parseInt(split.rest, 10);
  if (!Number.isSafeInteger(dbId)) return null;
  for (const repo of ctx.store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByGlobalId(ctx: Ctx, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const split = splitGlobalId(id);
  if (!split || split.kind !== 'Issue') return null;
  const [repoId, number] = split.rest.split(':');
  const dbId = Number.parseInt(repoId ?? '', 10);
  const num = Number.parseInt(number ?? '', 10);
  if (!Number.isSafeInteger(dbId) || !Number.isSafeInteger(num)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id !== dbId) continue;
    const issue = ctx.store.getIssue(repo, num);
    return issue ? { repo, issue } : null;
  }
  return null;
}

function findPullByGlobalId(ctx: Ctx, id: unknown): { repo: Repo; pull: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const split = splitGlobalId(id);
  if (!split || split.kind !== 'PullRequest') return null;
  const [repoId, number] = split.rest.split(':');
  const dbId = Number.parseInt(repoId ?? '', 10);
  const num = Number.parseInt(number ?? '', 10);
  if (!Number.isSafeInteger(dbId) || !Number.isSafeInteger(num)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id !== dbId) continue;
    const pull = ctx.store.getPull(repo, num);
    return pull ? { repo, pull } : null;
  }
  return null;
}

function doCreateIssue(ctx: Ctx, input: Record<string, unknown>, children: FieldNode[]): Record<string, unknown> {
  const repo = findRepoByGlobalId(ctx, input.repositoryId);
  if (!repo) throw new Error('repository not found');
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = ctx.store.createIssue(repo, title, body, []);
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('CreateIssuePayload', child);
    if (child.name === 'issue') out[child.alias] = resolveIssue(ctx, repo, issue, child.children);
    else if (child.name === 'clientMutationId') out[child.alias] = null;
  }
  return out;
}

function doCloseIssue(ctx: Ctx, input: Record<string, unknown>, children: FieldNode[]): Record<string, unknown> {
  const found = findIssueByGlobalId(ctx, input.issueId);
  if (!found) throw new Error('issue not found');
  found.issue.state = 'closed';
  found.issue.updatedAt = FIXED_ISO_TIME;
  found.issue.cachedJson = null;
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('CloseIssuePayload', child);
    if (child.name === 'issue') out[child.alias] = resolveIssue(ctx, found.repo, found.issue, child.children);
    else if (child.name === 'clientMutationId') out[child.alias] = null;
  }
  return out;
}

function doCreatePullRequest(ctx: Ctx, input: Record<string, unknown>, children: FieldNode[]): Record<string, unknown> {
  const repo = findRepoByGlobalId(ctx, input.repositoryId);
  if (!repo) throw new Error('repository not found');
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
  const pull = ctx.store.createPull(repo, title, body, headRef, baseRef, headSha, baseSha);
  const headTree = commitTree(repo, headSha);
  const baseTree = commitTree(repo, baseSha);
  pull.files = headTree !== null && baseTree !== null ? diffTrees(repo, baseTree, headTree) : [];
  pull.mergeable = squashConflicts(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('CreatePullRequestPayload', child);
    if (child.name === 'pullRequest') out[child.alias] = resolvePull(ctx, repo, pull, child.children);
    else if (child.name === 'clientMutationId') out[child.alias] = null;
  }
  return out;
}

function doMergePullRequest(ctx: Ctx, input: Record<string, unknown>, children: FieldNode[]): Record<string, unknown> {
  const found = findPullByGlobalId(ctx, input.pullRequestId);
  if (!found) throw new Error('pull request not found');
  const { repo, pull } = found;
  if (pull.merged) throw new Error('pull request is already merged');
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  if (headSha === null || baseSha === null) throw new Error('head or base branch is gone');
  if (squashConflicts(repo, baseSha, headSha)) throw new Error('merge conflict');
  const headTree = commitTree(repo, headSha);
  if (headTree === null) throw new Error('head has no tree');
  const squashSha = writeCommit(ctx.store, repo, pull.baseRef, headTree, pull.title);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO_TIME;
  pull.mergeSha = squashSha;
  pull.updatedAt = FIXED_ISO_TIME;
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('MergePullRequestPayload', child);
    if (child.name === 'pullRequest') out[child.alias] = resolvePull(ctx, repo, pull, child.children);
    else if (child.name === 'clientMutationId') out[child.alias] = null;
  }
  return out;
}

function doAddComment(ctx: Ctx, input: Record<string, unknown>, children: FieldNode[]): Record<string, unknown> {
  const found = findIssueByGlobalId(ctx, input.subjectId);
  if (!found) throw new Error('subject not found');
  const body = typeof input.body === 'string' ? input.body : '';
  const comment = ctx.store.addComment(found.issue, body);
  const out: Record<string, unknown> = {};
  for (const child of children) {
    checkField('AddCommentPayload', child);
    if (child.name === 'commentEdge') {
      const edge: Record<string, unknown> = {};
      for (const sub of child.children) {
        checkField('AddCommentEdge', sub);
        if (sub.name === 'node') {
          const node: Record<string, unknown> = {};
          for (const leaf of sub.children) {
            checkField('IssueComment', leaf);
            if (leaf.name === '__typename') node[leaf.alias] = 'IssueComment';
            else if (leaf.name === 'id') node[leaf.alias] = commentGlobalId(found.repo, found.issue, comment);
            else if (leaf.name === 'body') node[leaf.alias] = comment.body;
            else if (leaf.name === 'createdAt') node[leaf.alias] = comment.createdAt;
            else if (leaf.name === 'author') node[leaf.alias] = resolveUser(leaf.children);
          }
          edge[sub.alias] = node;
        } else if (sub.name === 'cursor') {
          edge[sub.alias] = encodeCursor(comment.id);
        }
      }
      out[child.alias] = edge;
    } else if (child.name === 'clientMutationId') {
      out[child.alias] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

function resolveQueryField(ctx: Ctx, field: FieldNode): unknown {
  checkField('Query', field);
  const args = argMap(field, ctx.variables);
  switch (field.name) {
    case 'viewer':
      return resolveUser(field.children);
    case 'repository': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = owner === VIEWER_LOGIN ? ctx.store.getRepo(owner, name) : undefined;
      return repo ? resolveRepository(ctx, repo, field.children) : null;
    }
    case 'node': {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const split = splitGlobalId(id);
      if (!split) return null;
      if (split.kind === 'Repository') {
        const repo = findRepoByGlobalId(ctx, id);
        if (!repo) return null;
        const wanted = field.children.filter((child) => child.fragmentType === null || child.fragmentType === 'Repository');
        return resolveRepository(ctx, repo, wanted);
      }
      if (split.kind === 'Issue') {
        const found = findIssueByGlobalId(ctx, id);
        if (!found) return null;
        const wanted = field.children.filter((child) => child.fragmentType === null || child.fragmentType === 'Issue');
        return resolveIssue(ctx, found.repo, found.issue, wanted);
      }
      if (split.kind === 'PullRequest') {
        const found = findPullByGlobalId(ctx, id);
        if (!found) return null;
        const wanted = field.children.filter((child) => child.fragmentType === null || child.fragmentType === 'PullRequest');
        return resolvePull(ctx, found.repo, found.pull, wanted);
      }
      return null;
    }
    case '__type': {
      const name = typeof args.name === 'string' ? args.name : '';
      return typeInfo(name, field.children);
    }
    case '__schema': {
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        checkField('__Schema', child);
        if (child.name === '__typename') out[child.alias] = '__Schema';
        else if (child.name === 'queryType') out[child.alias] = { name: 'Query' };
        else if (child.name === 'mutationType') out[child.alias] = { name: 'Mutation' };
        else if (child.name === 'subscriptionType') out[child.alias] = null;
        else if (child.name === 'types') out[child.alias] = Object.keys(TYPE_INFO).map((name) => ({ name }));
        else if (child.name === 'directives') out[child.alias] = [];
      }
      return out;
    }
    default:
      return null;
  }
}

function resolveMutationField(ctx: Ctx, field: FieldNode): unknown {
  checkField('Mutation', field);
  const args = argMap(field, ctx.variables);
  const input = (args.input !== null && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue':
      return doCreateIssue(ctx, input, field.children);
    case 'closeIssue':
      return doCloseIssue(ctx, input, field.children);
    case 'createPullRequest':
      return doCreatePullRequest(ctx, input, field.children);
    case 'mergePullRequest':
      return doMergePullRequest(ctx, input, field.children);
    case 'addComment':
      return doAddComment(ctx, input, field.children);
    default:
      return null;
  }
}

function executeOne(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): Record<string, unknown> {
  const ctx: Ctx = { store, variables };
  try {
    const parser = new Parser(query);
    const operations = parser.parseDocument();
    if (operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
    let operation = operations[0]!;
    if (operationName !== null) {
      const named = operations.find((candidate) => candidate.name === operationName);
      if (named) operation = named;
    }
    const data: Record<string, unknown> = {};
    for (const field of operation.fields) {
      if (field.name === '__typename') {
        data[field.alias] = operation.kind === 'query' ? 'Query' : 'Mutation';
        continue;
      }
      data[field.alias] =
        operation.kind === 'mutation' ? resolveMutationField(ctx, field) : resolveQueryField(ctx, field);
    }
    return { data };
  } catch (err) {
    if (err instanceof UnknownField) {
      return { errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
}

/**
 * Answer one GraphQL request body (a single operation object, or a batch
 * array). The caller owns auth and JSON parsing.
 */
export function handleGraphQL(store: Store, body: unknown): string {
  const run = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'request body must be an object' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables =
      record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
        ? (record.variables as Record<string, unknown>)
        : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    return executeOne(store, query, variables, operationName);
  };
  if (Array.isArray(body)) return JSON.stringify(body.map((entry) => run(entry)));
  return JSON.stringify(run(body));
}
