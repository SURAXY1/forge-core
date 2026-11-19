# forge-core

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/SURAXY1/forge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/SURAXY1/forge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process. No UI, no dependencies, no database: git smart
HTTP, the REST v3 API, GraphQL and an MCP endpoint all read and write the same in-memory store.

```
MAKEFUN_ENV_URL=http://env:8080 MAKEFUN_SHOP_TOKEN=secret node main.ts   # managed lifecycle
PORT=8099 MAKEFUN_SHOP_TOKEN=secret node main.ts                          # standalone, for local use
```

Needs Node 22.18 or newer (the sources are `.ts` files that contain plain JavaScript, so type
stripping has nothing to do). In the managed lifecycle the process listens on an ephemeral port,
posts it to `$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done` and exits 0 when told.

## What it serves

| Surface | Path | Notes |
| --- | --- | --- |
| Health | `GET /healthz` | no auth |
| Git | `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` | protocol v2 fetch (shallow, deepen, incremental), v0 push with side-band report |
| REST v3 | `/api/v3/...` | repos, branches, refs, commits, contents, labels, issues, comments, pulls, merges |
| GraphQL | `POST /api/graphql` | parsed and validated against a schema table; queries, mutations, introspection, batching |
| MCP | `POST /mcp` | JSON-RPC: `server/discover`, `initialize`, `tools/list`, `tools/call` |

Every request except `/healthz` needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` (git clients may
also send the token as the Basic password).

```
git -c http.extraHeader="Authorization: Bearer secret" clone http://127.0.0.1:8099/adaiversen/demo.git
curl -H "Authorization: Bearer secret" http://127.0.0.1:8099/api/v3/user
```

## Layout

| File | Role |
| --- | --- |
| `main.ts` | lifecycle: listen, register, poll, exit |
| `src/httpd.ts` | HTTP/1.1 on raw sockets: keep-alive, pipelining, Content-Length and chunked bodies |
| `src/server.ts` | authentication and dispatch to the four surfaces |
| `src/store.ts` | repositories, global node ids, clock |
| `src/gitobj.ts` | object hashing, tree and commit codecs, history walks, merge base |
| `src/pack.ts` | packfile reader (ofs/ref deltas) and writer, pkt-line and side-band framing |
| `src/githttp.ts` | ref advertisement, `ls-refs`, `fetch`, `receive-pack` |
| `src/ops.ts` | domain operations shared by REST, GraphQL and MCP: file commits, issues, pull requests, merges |
| `src/shapes.ts` | REST response shapes |
| `src/rest.ts` | REST routing |
| `src/gqlparse.ts`, `src/gqlschema.ts`, `src/graphql.ts` | GraphQL parser, schema table, validator and executor |
| `src/mcp.ts` | MCP tools over the same operations |

## Design notes

- One object map and one ref map per repository. A commit made through `PUT /contents` or a pull
  request merge is an ordinary git object, so a later `git fetch` sees it, and a branch pushed with
  git can be opened as a pull request over REST, GraphQL or MCP.
- Merges are three-way at path granularity: a path changed on both sides to different content is a
  conflict (HTTP 405 on REST, `CONFLICTING` in GraphQL).
- Fetch replies are cached per repository by request bytes and dropped on any ref change, so
  repeated identical clones cost one lookup.
- Issues keep their serialized REST form until they change.
- State lives in memory only and is gone when the process exits.

## Licence

MIT, see `LICENSE`.
