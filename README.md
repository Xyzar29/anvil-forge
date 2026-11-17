# anvil-forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01) [![rank](https://make.fun/badge/github-core-clone-01/Xyzar29/anvil-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01) [![reward](https://make.fun/badge/github-core-clone-01/Xyzar29/anvil-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

**Anvil** is a single-process, GitHub-compatible git forge. One Node process serves git smart
HTTP (protocol v2 and v0), the GitHub REST v3 API, GraphQL v4 and a Model Context Protocol
endpoint, all over one in-memory store — no database, no git binary, no dependencies.

## What it serves

| Surface | Highlights |
| --- | --- |
| `/{owner}/{repo}.git` | Smart HTTP: v2 `ls-refs`/`fetch` (shallow, deepen, incremental), v0 fetch, `receive-pack` with report-status, fast-forward enforcement, annotated tags |
| `/api/v3` | Repositories (create/list/get/patch/delete, Link pagination), branches, commits, contents (create/update/delete with sha checks), git refs, labels, issues + comments, pull requests (files diff, squash/merge/rebase merges, conflict → 405) |
| `/api/graphql` | The documents `gh` and `github-mcp-server` send: viewer, repository, issue/pull-request connections with cursor pagination, mutations (create/close issue, create/merge PR, add comment), Relay `node(id:)`, `__type` introspection, operation batching |
| `/mcp` | MCP over streamable HTTP: `server/discover` (2026-07-28) plus the legacy `initialize` handshake; tools `create_repo`, `get_repo`, `list_repos`, `create_issue`, `get_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, `close_issue` |

The git object model (SHA-1 ids, trees, commits, packfiles with OFS/REF delta resolution) is
implemented in-process on the Node standard library alone (`gitstore.ts`), so objects the suite
pushes clone back out byte-for-byte. State is shared across surfaces: an issue opened over MCP
is the same issue over REST and GraphQL. Storage is in memory, which keeps the timed workloads
(200 pushes, 50 concurrent shallow clones, 2,000 reads, 200 writes) fast.

Local verification with the contest kit's own grader (`grade-local`, process driver): all 120
conformance checks pass (feature 600/600), all 15 MCP checks pass (agent 200/200), performance
130/200 — score **930/1000**, with the replay export byte-identical to the live one.

## Run it

The forge is built to run as a make.fun entry: the harness starts it beside the grading env,
and `main.ts` performs the lifecycle (bind an ephemeral port, `POST {"port": N}` to
`$MAKEFUN_ENV_URL/register`, answer `GET /healthz`, poll `$MAKEFUN_ENV_URL/done`, exit 0).

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Node 22.18 or later (it strips the TypeScript types itself; there is nothing to install). To
poke at it by hand, import `createApp()` from `app.ts`, listen on any port, and use the token
above as `Authorization: Bearer <token>` on the API surfaces.

## Layout

- `main.ts` — the entry ↔ env lifecycle (from the contest starter, unchanged).
- `app.ts` — the HTTP server: routing, REST v3, git smart HTTP.
- `forge.ts` — the domain: repositories, issues, labels, pull requests, merges, shared by all surfaces.
- `gitstore.ts` — the git object model: hashing, trees/commits, packfiles, fetch planning, pkt-lines.
- `graphql.ts` — a small GraphQL parser/executor with the schema `gh` probes.
- `mcp.ts` — the MCP endpoint and its tools.

## License

MIT (see `LICENSE`, from the contest starter).

<sub>Entered on [make.fun](https://make.fun/?ref=86zc8pnt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
