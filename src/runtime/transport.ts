import { createServer } from "node:http";
import {
  createMcpHandler,
  type McpServer,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { serveStdio as sdkServeStdio } from "@modelcontextprotocol/server/stdio";
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";

/**
 * Connect the MCP server to stdio — the transport Claude Desktop uses. One
 * instance is pinned for the connection's lifetime; the SDK's opening
 * handshake picks the era (2026-07-28 per-request envelope, or a 2025-era
 * `initialize`) and serves the same registered tools either way.
 */
export async function serveStdio(server: McpServer): Promise<void> {
  sdkServeStdio(() => server);
}

export interface HttpServeOptions {
  port: number;
  host?: string;
  /** Path the MCP endpoint is mounted at. */
  path?: string;
}

/**
 * Serve the MCP server over Streamable HTTP — the transport the hosted product
 * exposes at `mcp.wrangl.io/servers/{slug}`. `build` is called once per
 * exchange (2026-07-28 requests are stateless by design; 2025-era traffic
 * gets the SDK's stateless fallback), so hot-reloading the spec a caller's
 * `build` closure reads from is picked up on the very next request with no
 * explicit reload plumbing needed here.
 */
export async function serveHttp(
  build: () => McpServer,
  opts: HttpServeOptions,
): Promise<() => Promise<void>> {
  const mountPath = opts.path ?? "/mcp";
  const factory: McpServerFactory = () => build();
  const handler = createMcpHandler(factory, { legacy: "stateless" });
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== mountPath) {
      res.writeHead(404).end("Not found");
      return;
    }
    // DNS-rebinding protections (spec: streamable-http#security-endpoint).
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    try {
      await nodeHandler(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500);
      res.end(`Internal error: ${message}`);
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", resolve),
  );

  return async () => {
    await handler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}
