# github-core-clone-entry-v3r

A standalone GitHub-compatible git forge in one Node process: git smart HTTP
(protocol v2 and v0), REST v3, GraphQL v4 and MCP, all over a single
in-memory store. No database, no cluster, no dependencies — the only
runtime requirement is Node ≥ 22.18 (the entrypoint runs on
`--experimental-strip-types`, no build step).

## Run it

```sh
node --experimental-strip-types main.ts
```

`PORT` selects the port (an ephemeral port when unset, never 8080). With
`MAKEFUN_ENV_URL` set, the server registers its port with the environment
and exits when the environment reports the trial done; without it, the
server just serves until killed. `GET /healthz` answers
`{"ok":true}` with no auth.

## Layout

| File | What it does |
| --- | --- |
| `seed.ts` | Fixed facts: viewer `adaiversen`, fixed timestamps, SHA-1 and global-id helpers. |
| `objects.ts` | Git object model: pkt-line codec, tree/commit/tag parse and build, pack read/write, delta application, reachability walks. |
| `store.ts` | The in-memory store: repos, issues, pull requests, labels, comments, refs, objects, plus the fetch/ls-refs/advertisement caches. |
| `refs.ts` | Ref listing and peeling, push validation (fast-forward only), merge-base, squash-conflict detection, tree diffs, commit and branch listing. |
| `git.ts` | Git smart HTTP: v2/v0 advertisements, ls-refs, fetch (v2 sections and v0 sideband), receive-pack pushes with report-status. |
| `rest.ts` | REST v3: repos, branches, commits, contents, labels, issues, comments, pull requests, squash merge. |
| `gql.ts` | GraphQL v4: a dependency-free parser and the resolvers, mutations, connections and introspection. |
| `mcp.ts` | MCP over streamable HTTP: the 12 tools, `server/discover`, the initialize handshake, `tools/list` and `tools/call`. |
| `main.ts` | The entrypoint: the HTTP server, Bearer auth, the read/write fast paths, and the register-then-wait lifecycle. |

## Contract notes

- Every timestamp the server emits is the fixed `2024-01-01T00:00:00Z`;
  the default branch is `main`; the viewer is `adaiversen`.
- Every REST reply carries a non-empty `X-GitHub-Request-Id`. A missing
  Bearer token is 401; a foreign owner is 404, never 403.
- Git pushes are fast-forward only; a non-fast-forward ref is refused with
  reason `non-fast-forward` and the other refs in the same push still apply.
- Shallow fetches honour the client's boundary: a deepen only sends the
  commits the client does not already hold, and the shallow-info section
  moves the boundary (a new `shallow` line, or `unshallow` for the old tip).
- Clone packs are built at deflate level 9; repeated identical fetches,
  ls-refs calls and advertisements are served from whole-response caches
  keyed by the repository's generation, so a repeated clone costs no
  re-computation.

## Local validation

From the kit directory, with a fresh server on port `PORT`:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK --perf --json
```

Local results for this entry (fresh server per run, 2026-11-14):

| Run | Checks | push | clone | read | write | Perf | Local score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 120/120 | 50 | 49 | 50 | 46 | 195 | 995 |
| 2 | 120/120 | 49 | 45 | 44 | 45 | 183 | 983 |

Real `git push` to the forge and `git clone` back round-trips byte-exact
(same HEAD, same object set, same commit/tree/blob bytes, `git fsck`
clean), and two fresh servers answering the same 17-request sequence
produce byte-identical response bodies.
