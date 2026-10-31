import {
  McpServer,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type RegisteredTool,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GeneratedServer, ToolAnnotationHints, ToolDef, ToolMode } from "../types.js";
import { toolInputShape, toolOutputShape } from "../generator/schema.js";
import { diffTools, type SpecDiff } from "../generator/diff.js";
import { filterTools } from "../generator/filter.js";
import {
  executeTool,
  type ProxyContext,
  type RequestLog,
} from "./proxy.js";
import { type CredentialStore } from "./auth.js";
import { confirmationCodec, digestArgs, type ConfirmationState } from "./confirmation.js";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  describeEndpoint,
  formatSearch,
  searchEndpoints,
} from "./discovery.js";

export interface RuntimeOptions {
  creds: CredentialStore;
  /** Optional request/response log sink (Usage Logs). */
  onLog?: (entry: RequestLog) => void;
  /** Refresh OAuth tokens on a 401 and signal whether to retry (see ProxyContext). */
  onUnauthorized?: (oauthSchemes: string[]) => Promise<boolean>;
  /**
   * Gate destructive tool calls (`annotations.destructiveHint`) behind an
   * MRTR confirmation prompt before executing. `true` (default): confirm
   * every destructive tool. `false`: never confirm. A predicate: confirm only
   * the tools it returns `true` for. Confirmation works for both 2026-07-28
   * clients (native `input_required`) and pre-2026 clients (the SDK's legacy
   * MRTR shim translates it into a real server-initiated elicitation).
   */
  confirmDestructive?: boolean | ((tool: ToolDef) => boolean);
  /**
   * How endpoints are exposed. "endpoints" (default): one MCP tool per
   * endpoint. "discovery": three tools, search_endpoints, describe_endpoint,
   * and call_endpoint, so a large API doesn't flood the agent's context.
   */
  toolMode?: ToolMode;
  /**
   * In discovery mode, endpoints matching these globs (as `--include` matches:
   * name, path, `METHOD path`, or tag) are also registered as direct tools,
   * so the calls an agent makes most skip the search step.
   */
  pin?: string[];
}

/** A live MCP server that can hot-reload its tools when the spec changes. */
export interface ReloadableServer {
  server: McpServer;
  /**
   * Apply a re-ingested spec to the running server: add/remove/update tools to
   * match, emitting `tools/list_changed` to connected clients. Returns the diff.
   */
  reload(next: GeneratedServer): SpecDiff;
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
  return createReloadableServer(generated, opts).server;
}

/**
 * Like {@link createMcpServer} but exposes a `reload` to hot-swap tools when the
 * upstream spec changes, without dropping the client connection.
 */
export function createReloadableServer(
  generated: GeneratedServer,
  opts: RuntimeOptions,
): ReloadableServer {
  const discovery = opts.toolMode === "discovery";
  const pinnedOf = (tools: ToolDef[]) =>
    discovery && opts.pin?.length ? filterTools(tools, { include: opts.pin }) : [];
  const initiallyPinned = pinnedOf(generated.tools);
  const server = new McpServer(
    { name: generated.name, version: generated.version },
    {
      requestState: { verify: confirmationCodec().verify },
      ...(discovery
        ? {
            instructions:
              `This server exposes the ${generated.name} API's ${generated.tools.length} ` +
              `endpoints through three tools: search_endpoints to find one, ` +
              `describe_endpoint for its parameters, and call_endpoint to run it.` +
              (initiallyPinned.length
                ? ` ${initiallyPinned.length} of them are also direct tools: ` +
                  `${initiallyPinned.map((t) => t.name).join(", ")}.`
                : ""),
          }
        : {}),
    },
  );

  // Mutable context so reloads can repoint baseUrl/schemes without rebuilding
  // every tool callback (the callbacks close over this object by reference).
  const ctx: ProxyContext = {
    baseUrl: generated.baseUrl,
    schemes: generated.securitySchemes,
    creds: opts.creds,
    onLog: opts.onLog,
    onUnauthorized: opts.onUnauthorized,
  };

  const registered = new Map<string, RegisteredTool>();
  const byName = new Map<string, ToolDef>();
  if (discovery) {
    for (const tool of generated.tools) byName.set(tool.name, tool);
    // In discovery mode `registered` holds just the pinned endpoints.
    registerDiscovery(server, byName, ctx, opts, generated.name, (name) => registered.has(name));
    for (const tool of initiallyPinned) registerOne(server, tool, ctx, opts, registered, byName);
  } else {
    for (const tool of generated.tools) registerOne(server, tool, ctx, opts, registered, byName);
  }

  function reload(next: GeneratedServer): SpecDiff {
    const diff = diffTools([...byName.values()], next.tools);
    ctx.baseUrl = next.baseUrl;
    ctx.schemes = next.securitySchemes;

    // Discovery's three tools read the endpoint map on every call, so swapping
    // its contents is the whole reload; the tool list itself never changes.
    // Pinned endpoints are real tools, so they're re-registered as they change.
    if (discovery) {
      const pinDiff = diffTools(
        [...byName.values()].filter((t) => registered.has(t.name)),
        pinnedOf(next.tools),
      );
      for (const name of [...pinDiff.removed, ...pinDiff.changed.map((c) => c.name)]) {
        registered.get(name)?.remove();
        registered.delete(name);
      }
      byName.clear();
      for (const tool of next.tools) byName.set(tool.name, tool);
      for (const name of [...pinDiff.added, ...pinDiff.changed.map((c) => c.name)]) {
        registerOne(server, byName.get(name)!, ctx, opts, registered, byName);
      }
      return diff;
    }

    const nextByName = new Map(next.tools.map((t) => [t.name, t]));

    // Removed and changed tools are torn down; changed + added are (re)created
    // with fresh schemas and a callback bound to the new ToolDef.
    for (const name of diff.removed) dropOne(name, registered, byName);
    for (const c of diff.changed) dropOne(c.name, registered, byName);
    for (const c of diff.changed) registerOne(server, nextByName.get(c.name)!, ctx, opts, registered, byName);
    for (const name of diff.added) registerOne(server, nextByName.get(name)!, ctx, opts, registered, byName);

    return diff;
  }

  return { server, reload };
}

function dropOne(
  name: string,
  registered: Map<string, RegisteredTool>,
  byName: Map<string, ToolDef>,
): void {
  registered.get(name)?.remove();
  registered.delete(name);
  byName.delete(name);
}

/** Whether calling `tool` should be gated behind a confirmation prompt. */
function needsConfirmation(tool: ToolDef, opts: RuntimeOptions): boolean {
  if (!tool.annotations?.destructiveHint) return false;
  const gate = opts.confirmDestructive ?? true;
  return typeof gate === "function" ? gate(tool) : gate;
}

const CONFIRM_KEY = "confirm";
const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Confirm",
      description: "Proceed with this action? It cannot be undone.",
    },
  },
  required: ["confirm"],
};

/** Build the confirmation prompt for a destructive call not yet confirmed. */
async function requestConfirmation(
  tool: ToolDef,
  args: Record<string, unknown>,
  mcp: ServerContext,
): Promise<InputRequiredResult> {
  const codec = confirmationCodec();
  return inputRequired({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: `Confirm ${tool.method} ${tool.pathTemplate}? This action is destructive and cannot be undone.`,
        requestedSchema: CONFIRM_SCHEMA,
      }),
    },
    requestState: await codec.mint(
      { tool: tool.name, argsDigest: digestArgs(args) } satisfies ConfirmationState,
      mcp,
    ),
  });
}

/**
 * The destructive-action gate, shared by endpoint tools and call_endpoint.
 * Returns what to send back instead of running the call (a confirmation
 * prompt, or a cancellation), or undefined once the call is confirmed.
 */
async function confirmationGate(
  tool: ToolDef,
  args: Record<string, unknown>,
  mcp: ServerContext,
  opts: RuntimeOptions,
): Promise<CallToolResult | InputRequiredResult | undefined> {
  if (!needsConfirmation(tool, opts)) return undefined;

  const view = inputResponse(mcp.mcpReq.inputResponses, CONFIRM_KEY);
  if (view.kind === "elicit" && view.action === "decline") {
    return errorResult("Cancelled: user declined to confirm.");
  }
  if (view.kind === "elicit" && view.action === "cancel") {
    return errorResult("Cancelled: no confirmation was provided.");
  }

  const state = mcp.mcpReq.requestState<ConfirmationState>();
  const confirmed = view.kind === "elicit" && view.action === "accept";
  // The requestState must match THIS exact call (spec: bind requestState
  // to an identifier for the originating request) — otherwise a
  // confirmation minted for one call could be replayed onto another. Through
  // call_endpoint, `tool` is the endpoint being called, so a confirmation is
  // bound to that endpoint, not to call_endpoint as a whole.
  const matches = state?.tool === tool.name && state?.argsDigest === digestArgs(args);
  return confirmed && matches ? undefined : requestConfirmation(tool, args, mcp);
}

/** Call the endpoint and shape the response for the agent. */
async function runEndpoint(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ProxyContext,
  outputSchema?: z.ZodTypeAny,
): Promise<CallToolResult> {
  const result = await executeTool(tool, args, ctx);
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
}

function registerOne(
  server: McpServer,
  tool: ToolDef,
  ctx: ProxyContext,
  opts: RuntimeOptions,
  registered: Map<string, RegisteredTool>,
  byName: Map<string, ToolDef>,
): void {
  const outputSchema = toolOutputShape(tool);

  const handle = server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: toolInputShape(tool),
      ...(outputSchema ? { outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    },
    async (
      rawArgs: Record<string, unknown>,
      mcp: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
      const args = rawArgs ?? {};
      return (await confirmationGate(tool, args, mcp, opts)) ?? runEndpoint(tool, args, ctx, outputSchema);
    },
  );
  registered.set(tool.name, handle);
  byName.set(tool.name, tool);
}

/** search_endpoints and describe_endpoint only read the endpoint list. */
const LOCAL_READ_ONLY: ToolAnnotationHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Register discovery mode's three tools over the live endpoint map (see
 * discovery.ts). call_endpoint validates arguments against the endpoint's own
 * schema, then goes through the same confirmation gate and proxy as an
 * endpoint tool, so the indirection doesn't bypass either.
 */
function registerDiscovery(
  server: McpServer,
  byName: Map<string, ToolDef>,
  ctx: ProxyContext,
  opts: RuntimeOptions,
  apiName: string,
  isPinned: (name: string) => boolean,
): void {
  const all = () => [...byName.values()];
  const unknown = (name: string): CallToolResult => {
    const near = searchEndpoints(all(), name, 3).map((m) => m.tool.name);
    return errorResult(
      `Unknown endpoint "${name}". ` +
        (near.length ? `Did you mean: ${near.join(", ")}?` : "Use search_endpoints to find one."),
    );
  };

  server.registerTool(
    "search_endpoints",
    {
      description:
        `Search the ${apiName} API's endpoints by keyword, e.g. "create issue" or ` +
        `"list invoices". Returns the best matches by name; use describe_endpoint ` +
        `for an endpoint's parameters, then call_endpoint to run it.`,
      inputSchema: {
        query: z.string().min(1).describe("Words for what you want to do, or the resource involved."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`How many matches to return (default ${DEFAULT_SEARCH_LIMIT}, at most ${MAX_SEARCH_LIMIT}).`),
      },
      annotations: LOCAL_READ_ONLY,
    },
    async ({ query, limit }): Promise<CallToolResult> =>
      textResult(formatSearch(query, searchEndpoints(all(), query, limit), byName.size, isPinned)),
  );

  server.registerTool(
    "describe_endpoint",
    {
      description:
        "Get one endpoint's full description and the JSON Schema of its arguments, " +
        "by the name search_endpoints returned.",
      inputSchema: { name: z.string().describe("The endpoint's name, from search_endpoints.") },
      annotations: LOCAL_READ_ONLY,
    },
    async ({ name }): Promise<CallToolResult> => {
      const tool = byName.get(name);
      return tool ? textResult(describeEndpoint(tool)) : unknown(name);
    },
  );

  server.registerTool(
    "call_endpoint",
    {
      description:
        "Call an endpoint by name with its arguments, as describe_endpoint lists them. " +
        "Destructive endpoints ask for confirmation before they run.",
      inputSchema: {
        name: z.string().describe("The endpoint's name, from search_endpoints."),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The endpoint's arguments, matching its input schema."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: all().some((t) => t.annotations?.destructiveHint),
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, arguments: args }, mcp): Promise<CallToolResult | InputRequiredResult> => {
      const tool = byName.get(name);
      if (!tool) return unknown(name);
      // Endpoint tools get this validation from the SDK; here it's explicit.
      const parsed = z.object(toolInputShape(tool)).safeParse(args ?? {});
      if (!parsed.success) {
        return errorResult(
          `Invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}\n\n` +
            `describe_endpoint lists the arguments it takes.`,
        );
      }
      const valid = parsed.data as Record<string, unknown>;
      return (await confirmationGate(tool, valid, mcp, opts)) ?? runEndpoint(tool, valid, ctx);
    },
  );
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
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
