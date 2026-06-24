import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GeneratedServer } from "../types.js";
import { toolInputShape, toolOutputShape } from "../generator/schema.js";
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
    const outputSchema = toolOutputShape(tool);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: toolInputShape(tool),
        ...(outputSchema ? { outputSchema } : {}),
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const result = await executeTool(tool, args ?? {}, ctx);
        const base: CallToolResult = {
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

        // When the tool declares an output schema, a successful call must carry
        // structuredContent that validates against it (the SDK enforces this).
        // Validate here and fall back to {} — the schema is all-optional, so {}
        // always passes — guaranteeing a divergent response can't crash the
        // call. The full body is always available in the text content above.
        if (outputSchema && result.ok) {
          const parsed = outputSchema.safeParse(asObject(result.body));
          base.structuredContent = parsed.success
            ? (parsed.data as Record<string, unknown>)
            : {};
        }
        return base;
      },
    );
  }

  return server;
}

/** Parse a response body to a plain object, or {} if it isn't one. */
function asObject(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatResult(status: number, ok: boolean, body: string): string {
  const prefix = ok
    ? `HTTP ${status}`
    : `HTTP ${status} (upstream error)`;
  const trimmed = body.length > 0 ? body : "(empty response body)";
  return `${prefix}\n\n${trimmed}`;
}
