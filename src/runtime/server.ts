import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GeneratedServer } from "../types.js";
import { toolInputShape } from "../generator/schema.js";
import {
  executeTool,
  type ProxyContext,
  type RequestLog,
} from "./proxy.js";
import { type CredentialStore } from "./auth.js";

export interface RuntimeOptions {
  creds: CredentialStore;
  /** Optional request/response log sink (Usage Logs). */
  onLog?: (entry: RequestLog) => void;
}

/**
 * Build a live MCP server from a GeneratedServer description. Each tool, when
 * called by an agent, proxies through to the upstream REST API with auth
 * injected. This is the dynamic runtime — one codebase serves any spec.
 */
export function createMcpServer(
  generated: GeneratedServer,
  opts: RuntimeOptions,
): McpServer {
  const server = new McpServer({
    name: generated.name,
    version: generated.version,
  });

  const ctx: ProxyContext = {
    baseUrl: generated.baseUrl,
    schemes: generated.securitySchemes,
    creds: opts.creds,
    onLog: opts.onLog,
  };

  for (const tool of generated.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: toolInputShape(tool),
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const result = await executeTool(tool, args ?? {}, ctx);
        return {
          // Surface HTTP errors to the agent rather than throwing, so it can
          // adapt (retry, fix params) instead of seeing an opaque failure.
          isError: !result.ok,
          content: [
            {
              type: "text",
              text: formatResult(result.statusCode, result.ok, result.body),
            },
          ],
        };
      },
    );
  }

  return server;
}

function formatResult(status: number, ok: boolean, body: string): string {
  const prefix = ok
    ? `HTTP ${status}`
    : `HTTP ${status} (upstream error)`;
  const trimmed = body.length > 0 ? body : "(empty response body)";
  return `${prefix}\n\n${trimmed}`;
}
