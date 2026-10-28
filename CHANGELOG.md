# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

## [0.5.0] - 2026-10-28

### Added

- **`--env KEY=value` on `install` and `add`.** Puts an API key (or any
  variable) in the agent client's config, where the server can see it. The
  install hint now suggests this: clients like Claude Desktop usually start
  servers without your shell's environment, so the `export` it used to
  suggest never reached them.
- **`--catalog <id>` on `generate` and `inspect`.** Loads a ready-made spec
  by its catalog id.
- **`--log-retention <days>` on `serve` and `generate`** (or
  `WRANGL_LOG_RETENTION_DAYS`). Usage logs older than that are pruned at
  startup and hourly; `0` keeps them forever.
- **`scripts/catalog-counts.mjs`** re-counts the tools each catalog entry
  generates and updates the numbers `wrangl catalog` shows.
- **Commented config files.** `install` now reads Zed's `settings.json` and
  VS Code's `mcp.json` with comments and trailing commas (JSONC), and edits
  them in place: only the server's own entry changes, and every comment and
  the formatting of other entries survive. Previously these files were
  refused as invalid JSON.

### Changed

- **The control plane checks the `Host` header when it has no admin token.**
  It answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]`, the
  `--host` it's bound to, or the `--public-url` host, and returns 403
  otherwise. This blocks DNS rebinding, where a web page re-points its own
  domain at your machine and calls the unauthenticated API from your browser.
  Set an admin token to serve other host names.
- **Creating a server whose name is taken gets a new slug** (`api-2`), also
  when the existing server was created by another replica. Previously a
  replica that hadn't loaded it reused the slug, overwriting that server's
  record and inheriting its stored credentials.
- **The dashboard's tool tester returns 400 for invalid arguments** instead
  of 502.
- **Usage logs are kept for 30 days by default.** They hold request and
  response bodies and used to grow forever. Pass `--log-retention 0` to keep
  everything.
- **Enrichment defaults to `claude-opus-5-5`**, which is newer and cheaper per
  token than `claude-opus-4-8`. On Opus 5.5, Opus 5, and Fable 5.1, a batch the
  model declines is re-run on `claude-opus-4-8` within the same request (the
  API's server-side fallback, billed at that model's rates), and a batch that
  still comes back unenriched is reported instead of skipped silently.
- **Library: the store interfaces grew.** A custom `ServerStore` must now
  implement `savePendingAuth`, `takePendingAuth`, and `prunePendingAuth`, and a
  custom `LogStore` must implement `prune`. `ServerRecord` gains
  `toolFilter` and `updatedAt`.

### Fixed

- **Installed servers no longer break when npm prunes its cache.** Run
  through `npx`, `install` wrote the path of npx's cache into the agent's
  config. It now writes `npx -y @asgerami/wrangl@<version>`, which npx can
  always re-fetch. Bundled catalog specs are recorded by catalog id instead of
  by a path inside the package, and a relative spec path is made absolute,
  since the client starts the server from its own working directory.
- **Replicas stay in sync.** A replica kept every server it had loaded, so a
  server deleted, regenerated, or given new credentials on another replica
  kept being served as it was. Records now carry a version; a replica
  re-checks its copy against the shared store once it's 5 seconds old, and
  `GET /servers` reconciles with the store before listing.
- **OAuth sign-ins work across replicas.** A sign-in in progress was held in
  one replica's memory, so it failed whenever the provider's redirect reached
  another. It's now kept in the shared store (encrypted, single-use, expiring
  after 10 minutes), and other replicas pick up the resulting token.
- **Postman `{{variable}}` path segments become path parameters.** Only
  `:variable` was recognized, so `/users/{{userId}}` was sent upstream
  literally.
- **Control-plane tool filters work.** `POST /servers` ignored `include` and
  `exclude`, and the filter was never stored, so a restart, `regenerate`, or
  another replica brought back the full tool list. Filters are now applied,
  persisted, and re-applied; a filter that removes every tool is a 400.
- **The Docker image builds again.** `npm ci` runs the `prepare` script,
  which lives in `scripts/`, and the Dockerfile didn't copy that directory, so
  the build has failed since 0.2.0. CI now builds the image on every change.
- **`--watch` picks up parameter type, enum, and description changes**, and
  tool annotation changes. They didn't count as a change, so the running
  server kept the stale schema.
- **OAuth tokens whose `expires_in` is a numeric string** (as some providers
  send it) are now refreshed ahead of expiry, not only after a 401.
- **An API-key cookie no longer replaces cookie parameters.** It's sent with
  them, and wins over a parameter of the same name.
- **Enrichment errors say what to fix.** Every failure reported the same
  structured-outputs hint; an invalid key, an unknown model, and a network
  failure now each get their own.
- **Postgres databases created before per-server MCP tokens** gain the
  `mcp_token` column on connect, as SQLite ones already did.
- **The `/logs` endpoint** rejects non-integer `limit` and `status` values and
  caps `limit` at 1,000.
- **`wrangl catalog` tool counts are current.** They're fixed numbers in the
  manifest and had drifted as upstream specs grew.

### Security

- **Updated `@modelcontextprotocol/node` to 2.1.2** for
  [GHSA-f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq)
  (high): its HTTP transports didn't limit request body size or JSON-RPC
  batch length. The hosted MCP endpoints use it.
- **Bearer tokens are compared in constant time**, for both the admin token
  and the per-server MCP tokens.
- **Confirmation signing no longer reuses the vault's key.** When
  `WRANGL_SECRET_KEY` is a raw hex or base64 key, the vault used it directly
  and so did the confirmation signer. The signer now derives its own key with
  HKDF. Stored credentials are unaffected; confirmations in flight during the
  upgrade (5-minute lifetime) must be re-confirmed.

## [0.4.1] - 2026-10-27

### Fixed

- **POST/PATCH are no longer re-sent after a network error.** The retry
  guard covered 5xx responses but not network errors, so a POST whose
  connection dropped after the upstream received it was sent up to three
  times. Network-error retries are now limited to the same idempotent methods
  (GET, HEAD, OPTIONS, PUT, DELETE) as 5xx retries.
- **Path parameters can't escape their endpoint.** A path argument of `.` or
  `..` was resolved by URL parsing, so a call could reach a different
  endpoint on the same host (bypassing `--include` / `--exclude`) with the
  credentials still injected. Such values are now rejected before any request
  is sent.
- **Invalid arguments fail immediately.** A request that can't be built (e.g.
  a missing required parameter) was retried with backoff and then reported as
  "Upstream request failed". It now fails at once with the real error, and is
  still logged.
- **Failed requests no longer log query-string credentials.** The error path
  logged the full request URL, including an API key injected into the query
  string. It now logs the redacted URL, like successful calls do.
- **Upstream calls time out.** The proxy's `fetch` had no deadline, so an
  API that never answered (or stalled mid-body) hung the tool call
  indefinitely. Each attempt now has a 60s deadline covering the response
  body, configurable via `ProxyContext.timeoutMs`. A timeout counts as a
  network error: retried for idempotent methods, never for POST/PATCH.

### Security

- **Cleared all 13 `npm audit` advisories** (1 critical, 9 high, 3
  moderate) by updating dependencies within their existing semver ranges,
  including `@modelcontextprotocol/server` 2.0.0 → 2.4.0, `fastify` 5.8.5 →
  5.12.7, `zod` 4.4.3 → 4.6.7, and `proxy-addr` 2.0.7 → 2.0.8. Lockfile
  only; `package.json` is unchanged.

## [0.4.0] - 2026-08-04

### Added

- **MCP protocol `2026-07-28` support.** The runtime now targets the
  stateless, per-request revision of MCP — migrated from
  `@modelcontextprotocol/sdk` v1 to the new `@modelcontextprotocol/server` v2
  SDK (`createMcpHandler` for HTTP, `serveStdio` for stdio), used by the CLI's
  `generate --transport http|stdio` and the hosted control plane's
  `/servers/:id/mcp` endpoint alike. One tool registration now serves both
  `2026-07-28` clients (native `resultType`, `ttlMs`/`cacheScope` cache hints
  on `tools/list`) and every earlier client (`2025-11-25` and back) via the
  SDK's built-in legacy fallback — verified end-to-end against both a raw
  modern HTTP exchange and the existing `@modelcontextprotocol/sdk` v1
  client/`InMemoryTransport` test suite.
- **Tool annotations.** Every generated tool now carries `readOnlyHint` /
  `destructiveHint` / `idempotentHint` / `openWorldHint`, derived from the
  HTTP verb (`GET`/`HEAD` read-only; `DELETE`/`PUT`/`PATCH` destructive by
  default, overridable via `destructiveMethods`; `POST` neither).
- **Destructive-action confirmation.** Tools with `destructiveHint: true` now
  require an agent-confirmed elicitation before they execute, using MCP's
  multi-round-trip request (MRTR) pattern. The `requestState` binding a
  confirmation to its exact call is HMAC-SHA256 signed and digest-bound to
  the call's arguments (via the SDK's `createRequestStateCodec`) — a
  confirmation for one call can't be replayed onto another, and a tampered or
  expired token is rejected rather than silently honored. Configurable via
  `RuntimeOptions.confirmDestructive`; keyed by `WRANGL_SECRET_KEY` (falls
  back to a random per-process key with a startup warning if unset).

## [0.3.0] - 2026-07-20

### Added

- **More `install`/`add` clients.** `--client` now also accepts `windsurf`,
  `cline`, `zed`, and `vscode`, alongside `claude` and `cursor`. Zed and VS
  Code use their own config shape (`context_servers`/`source: "custom"` and
  `servers`/`type: "stdio"` respectively) — handled automatically per client.
- **Grew the catalog.** `wrangl add` now also has `discord` (242 tools),
  `slack` (174 tools, via APIs.guru's OpenAPI 3.0 conversion — Slack's own
  spec is still Swagger 2.0), `sendgrid` (3 tools; mail-sending API only —
  SendGrid's spec is split into 46 per-resource files with no combined doc),
  and `pagerduty` (465 tools).
- **Proxy resilience.** Transient upstream failures (network errors, or a
  502/503/504/500) are now retried automatically with exponential backoff —
  2 retries by default, configurable via `ProxyContext.maxRetries`. Retries
  are limited to methods with no side effect to duplicate (GET, HEAD,
  OPTIONS, PUT, DELETE); POST/PATCH responses are returned as-is so a lost
  response never risks re-running a write twice.

## [0.2.0] - 2026-07-18

### Changed

- **Package name.** Published as `@asgerami/wrangl` — npm rejected the unscoped
  name `wrangl` as too similar to Cloudflare's `wrangler`. The CLI binary is
  still `wrangl`; install with `npx @asgerami/wrangl …`.

### Added

- **Tool filters.** `--include` / `--exclude` (glob) on `generate`, `inspect`,
  `install`, and `add` match tool name, path, `METHOD path`, or OpenAPI tags.
  The control plane `POST /servers` body accepts `include` / `exclude` arrays
  too. Use this to keep huge catalogs (GitHub, Stripe) agent-usable.
- **OAuth2 client_credentials.** Machine-to-machine grant via
  `POST /servers/:id/oauth/:scheme/client-credentials`, with a dashboard button.
  Specs that only advertise `clientCredentials` no longer require an
  authorization URL.
- **OpenID Connect.** `openIdConnect` security schemes are ingested; discovery
  documents supply authorize/token endpoints for the OAuth manager.
- **CI.** Postgres job on every PR; nightly workflow runs live-network tests and
  Postgres. Tag `v*` publishes to npm (`NPM_TOKEN` secret) with pack-content
  checks.

### Changed

- README documents a from-source install path alongside `npx`.

## [0.1.0] - 2026-07-15

First public release. Wrangl turns any REST API into an agent-ready MCP server.

### Added

- **Ingestion.** OpenAPI 3.x, Swagger 2.0, and Postman collections, from a URL
  or a local path. Auto-discovery probes well-known spec paths from a bare base
  URL and reads the docs page to find a referenced spec. Relative server URLs
  resolve against the spec source.
- **Generation.** Every operation becomes an MCP tool, with a JSON Schema to Zod
  converter, full parameter serialization (`style`/`explode`, `deepObject`,
  space and pipe delimited arrays), response output schemas, and safe handling
  of recursive schemas.
- **Runtime.** stdio and Streamable HTTP transports, an upstream proxy that
  injects credentials server-side (Bearer, Basic, API key, OAuth2), a reloadable
  server with live spec sync (`--watch`), and a SQLite usage-log store.
- **Semantic enrichment.** Optional LLM pass that improves tool names and
  descriptions.
- **Control plane.** A Fastify REST API with hosted MCP endpoints, an in-process
  server registry, durable server records (SQLite or Postgres), an AES-256-GCM
  credential vault, and the full OAuth2 authorization-code flow (PKCE, encrypted
  tokens, auto-refresh).
- **Dashboard.** A self-contained UI to create servers, run any tool
  interactively, browse request/response logs, view per-server analytics, and
  manage credentials.
- **CLI.** `generate`, `serve`, `logs`, `install` (one command from an API to a
  wired-up agent client), `add`, and `catalog`. Auto-loads `.env.local` / `.env`.
- **Catalog.** A prebuilt manifest of ready-made servers: Petstore,
  JSONPlaceholder, GitHub (1,204 tools), Stripe (587), OpenAI (242), Twilio (197).
- **Deployment.** Docker image and Compose files, Caddy TLS, admin token,
  per-server tokens and rate limits, and a Postgres backend for multiple replicas.

[Unreleased]: https://github.com/asgerami/wrangl/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/asgerami/wrangl/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/asgerami/wrangl/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/asgerami/wrangl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/asgerami/wrangl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/asgerami/wrangl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/asgerami/wrangl/releases/tag/v0.1.0
