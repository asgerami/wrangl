<p align="center">
  <img src="docs/hero.svg" alt="Wrangl: turn any REST API into an agent-ready MCP server in one command" width="820" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@asgerami/wrangl"><img src="https://img.shields.io/npm/v/@asgerami/wrangl" alt="npm version" /></a>
  <a href="https://github.com/asgerami/wrangl/actions/workflows/ci.yml"><img src="https://github.com/asgerami/wrangl/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@asgerami/wrangl" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="docs/GUIDE.md"><b>Documentation</b></a>
  &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md">Architecture</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
  &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Wrangl turns any REST API into a
[Model Context Protocol](https://modelcontextprotocol.io) server, so AI
agents like Claude and Cursor can call it. Give it an OpenAPI spec, a
Postman collection, or just a base URL, and every endpoint becomes a tool.
Your API keys stay on the server, so the agent never sees them.

## Quick start

Wrangl needs Node.js 22 or newer.

```bash
npx @asgerami/wrangl install https://petstore3.swagger.io
```

Wrangl finds the API's spec, generates the tools, and adds the server to
Claude Desktop. Restart Claude and the API is ready to use. For another
agent, add `--client` with `cursor`, `windsurf`, `cline`, `zed`, or
`vscode`.

No spec? Add a ready-made server from the catalog:

```bash
npx @asgerami/wrangl catalog      # list what's available
npx @asgerami/wrangl add stripe   # 600+ tools
npx @asgerami/wrangl add github --include "repos*"
```

For an API that needs a key, pass it with `--env`, for example
`--env WRANGL_BEARER_TOKEN=...`; see
[Authentication](docs/GUIDE.md#authentication).

## Dashboard

```bash
npx @asgerami/wrangl serve        # http://localhost:4000
```

Create servers, run any tool from the browser, and watch request logs,
error rates, and latency.

<p align="center">
  <img src="docs/dashboard.png" alt="Wrangl dashboard running a generated tool against a live API and showing the JSON response" width="900" />
</p>

## Features

- **One command.** `install` finds the spec, generates the tools, and
  updates your agent's config, backing it up first.
- **Built-in catalog.** Ready-made servers for GitHub, Stripe, OpenAI,
  Twilio, Discord, Slack, SendGrid, and PagerDuty.
- **Spec discovery.** Point it at a base URL and it finds the spec, even
  when it's only linked from a docs page.
- **Real-world specs.** OpenAPI 3.x and Postman collections, including
  recursive schemas. `--include` and `--exclude` trim huge APIs down to the
  tools an agent needs.
- **Auth built in.** Bearer, Basic, API keys, OAuth2 (PKCE and client
  credentials), and OpenID Connect.
- **Safe by default.** Destructive tools ask the agent to confirm, POST and
  PATCH are never retried, and upstream calls time out.
- **Ready to deploy.** Docker image, admin auth, per-server tokens and rate
  limits, and PostgreSQL for running several replicas.
- **Current with MCP.** Targets protocol revision `2026-07-28` and still
  serves older clients.
- **Optional LLM pass.** `--enrich` uses Claude to turn raw names like
  `post_v1_contacts` into clear tool names and descriptions.

## Use it as a library

```ts
import { ingest, createMcpServer, serveStdio } from "@asgerami/wrangl";

const generated = await ingest("https://api.example.com/openapi.json");

const server = createMcpServer(generated, {
  creds: { bearerAuth: process.env.API_TOKEN! },
});

await serveStdio(server);
```

## Documentation

- **[Guide](docs/GUIDE.md):** every command and flag, authentication and
  OAuth2, the dashboard and REST API, and deploying with Docker and
  PostgreSQL.
- **[Architecture](docs/ARCHITECTURE.md):** how Wrangl works and the design
  decisions behind it.
- **[Changelog](CHANGELOG.md):** release history.

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and tests, and
[SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE) © [asgerami](https://github.com/asgerami)
