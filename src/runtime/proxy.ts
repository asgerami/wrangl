import type { SecurityScheme, ToolDef } from "../types.js";
import { buildAuthInjection, type CredentialStore } from "./auth.js";

export interface ProxyContext {
  baseUrl: string;
  schemes: Record<string, SecurityScheme>;
  creds: CredentialStore;
  /** Optional hook for request/response logging (the Usage Logs feature). */
  onLog?: (entry: RequestLog) => void;
  /**
   * Called with the tool's OAuth2 scheme names after a 401, to refresh the
   * access token(s). Returning true means a token was refreshed (creds updated
   * in place), so the call is retried once. Enables OAuth token auto-refresh.
   */
  onUnauthorized?: (oauthSchemes: string[]) => Promise<boolean>;
  /**
   * Max automatic retries for transient upstream failures (network errors or a
   * 5xx response), for methods with no side effect to duplicate: GET, HEAD,
   * OPTIONS, PUT, DELETE. POST/PATCH are never retried — a request that failed
   * mid-flight may still have run upstream, and re-sending it could repeat a
   * write. Default 2; set 0 to disable.
   */
  maxRetries?: number;
  /**
   * Per-attempt deadline for an upstream call in ms, covering the response
   * body as well as the headers. A timeout counts as a network error: retried
   * for idempotent methods, never for POST/PATCH. Default 60000, matching the
   * MCP TypeScript SDK's default client request timeout — past that, most
   * agents have already given up on the call.
   */
  timeoutMs?: number;
}

export interface RequestLog {
  tool: string;
  method: string;
  url: string;
  statusCode?: number;
  latencyMs: number;
  error?: string;
  /** JSON of the tool arguments (never contains injected credentials). */
  requestBody?: string;
  /** Upstream response body, truncated for storage. */
  responseBody?: string;
}

/** Cap stored payloads so the log store doesn't balloon on large responses. */
const MAX_PAYLOAD_CHARS = 8192;

/** 5xx statuses worth an automatic retry — gateway hiccups and generic server errors. */
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
/** Methods with no side effect to duplicate if a retried call actually lands twice. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter exponential backoff, capped, so concurrent retries don't sync up. */
function backoffDelay(attempt: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.random() * cap;
}

function truncate(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}… [truncated ${text.length - MAX_PAYLOAD_CHARS} chars]`
    : text;
}

/**
 * The tool call's arguments can't form a valid request (a missing required
 * parameter, a path value that would change the endpoint). The caller's
 * mistake, never retried, as opposed to an upstream failure.
 */
export class ToolArgumentError extends Error {
  override name = "ToolArgumentError";
}

export interface ProxyResult {
  statusCode: number;
  ok: boolean;
  body: string;
  contentType: string | null;
}

/**
 * Execute one upstream HTTP call for a tool invocation: substitute path params,
 * build the query string, attach headers and body, inject auth, and return the
 * normalized response. All user credentials stay server-side.
 */
export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ProxyContext,
): Promise<ProxyResult> {
  const start = performance.now();
  const maxRetries = ctx.maxRetries ?? DEFAULT_MAX_RETRIES;
  const canRetry = IDEMPOTENT_METHODS.has(tool.method.toUpperCase());
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const logFailure = (url: string, err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    ctx.onLog?.({
      tool: tool.name,
      method: tool.method,
      url,
      latencyMs: Math.round(performance.now() - start),
      error: message,
      requestBody: truncate(JSON.stringify(args)),
    });
    return message;
  };

  // Building the request is deterministic — a bad argument fails the same way
  // every time — so it happens once, before the retry loop: it's never retried,
  // and its error reaches the caller as-is rather than posing as an upstream
  // failure. It's still logged, so rejected calls show up in Usage Logs.
  let built: BuiltRequest;
  try {
    built = buildRequest(tool, args, ctx);
  } catch (err) {
    logFailure(joinUrl(ctx.baseUrl, tool.pathTemplate), err);
    throw err;
  }
  // Redacted, since query-string credentials are injected into built.url.
  const url = redactUrl(built.url);

  for (let attempt = 0; ; attempt++) {
    try {
      let response = await fetch(built.url, {
        method: tool.method,
        headers: built.headers,
        body: built.body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // On a 401 for an OAuth2-secured tool, refresh the token and retry once.
      if (response.status === 401 && ctx.onUnauthorized) {
        const oauthSchemes = tool.security.filter(
          (s) => ctx.schemes[s]?.type === "oauth2",
        );
        if (oauthSchemes.length && (await ctx.onUnauthorized(oauthSchemes))) {
          built = buildRequest(tool, args, ctx); // creds updated in place by refresh
          response = await fetch(built.url, {
            method: tool.method,
            headers: built.headers,
            body: built.body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        }
      }

      if (
        canRetry &&
        RETRYABLE_STATUSES.has(response.status) &&
        attempt < maxRetries
      ) {
        console.error(
          `⚠ ${tool.method} ${url} → ${response.status}; retrying (${attempt + 1}/${maxRetries})…`,
        );
        await sleep(backoffDelay(attempt));
        continue;
      }

      const contentType = response.headers.get("content-type");
      const body = await response.text();
      const result: ProxyResult = {
        statusCode: response.status,
        ok: response.ok,
        body,
        contentType,
      };

      ctx.onLog?.({
        tool: tool.name,
        method: tool.method,
        url,
        statusCode: response.status,
        latencyMs: Math.round(performance.now() - start),
        requestBody: truncate(JSON.stringify(args)),
        responseBody: truncate(body),
      });
      return result;
    } catch (caught) {
      // The timeout rejects with a bare "operation was aborted"; say what happened.
      const err =
        caught instanceof Error && caught.name === "TimeoutError"
          ? new Error(`timed out after ${timeoutMs}ms`)
          : caught;
      if (canRetry && attempt < maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `⚠ ${tool.method} ${url} failed (${message}); retrying (${attempt + 1}/${maxRetries})…`,
        );
        await sleep(backoffDelay(attempt));
        continue;
      }

      const message = logFailure(url, err);
      throw new Error(`Upstream request failed: ${message}`);
    }
  }
}

interface BuiltRequest {
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

function buildRequest(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ProxyContext,
): BuiltRequest {
  let path = tool.pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { Accept: "application/json" };

  for (const param of tool.params) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) {
        throw new ToolArgumentError(`Missing required parameter "${param.name}".`);
      }
      continue;
    }

    switch (param.location) {
      case "path":
        path = path.replace(
          new RegExp(`\\{${escapeRegex(param.sourceName)}\\}`, "g"),
          encodeURIComponent(stringify(value)),
        );
        break;
      case "query":
        serializeQuery(query, param, value);
        break;
      case "header":
        headers[param.sourceName] = stringify(value);
        break;
      case "cookie":
        headers["Cookie"] = appendCookie(
          headers["Cookie"],
          param.sourceName,
          stringify(value),
        );
        break;
    }
  }

  // URL parsing resolves "." and ".." segments, so an argument like ".." would
  // climb out of this tool's endpoint onto another on the same host, with the
  // credentials still injected. encodeURIComponent leaves dots alone, so refuse
  // any such segment outright.
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ToolArgumentError(
      `Invalid path "${path}": path parameters can't be "." or "..", which would ` +
        `redirect the call to a different endpoint.`,
    );
  }

  let body: string | undefined;
  if (tool.body) {
    const bodyValue = args.body;
    if (bodyValue === undefined && tool.body.required) {
      throw new ToolArgumentError(`Missing required request body argument "body".`);
    }
    if (bodyValue !== undefined) {
      body = JSON.stringify(bodyValue);
      headers["Content-Type"] = tool.body.contentType.includes("json")
        ? "application/json"
        : tool.body.contentType;
    }
  }

  // Inject credentials last so they take precedence and are never overridden.
  const auth = buildAuthInjection(tool.security, ctx.schemes, ctx.creds);
  const paramCookies = headers["Cookie"];
  Object.assign(headers, auth.headers);
  // An API key sent as a cookie joins the cookie parameters instead of
  // replacing them; it goes first, and a same-named parameter is dropped.
  if (auth.headers["Cookie"] && paramCookies) {
    headers["Cookie"] = mergeCookies(auth.headers["Cookie"], paramCookies);
  }
  for (const [k, v] of Object.entries(auth.query)) query.set(k, v);

  const url = new URL(joinUrl(ctx.baseUrl, path));
  for (const [k, v] of query.entries()) url.searchParams.append(k, v);

  return { url, headers, body };
}

/**
 * Serialize a query parameter according to its OpenAPI `style` + `explode`.
 * Covers the encodings real specs use: form (default, explode and joined),
 * space/pipe-delimited arrays, and deepObject / form object encodings.
 */
function serializeQuery(
  query: URLSearchParams,
  param: { sourceName: string; style: import("../types.js").ParamStyle; explode: boolean },
  value: unknown,
): void {
  const key = param.sourceName;

  if (Array.isArray(value)) {
    const items = value.map(stringify);
    if (param.explode) {
      // form/spaceDelimited/pipeDelimited + explode → one pair per item.
      for (const v of items) query.append(key, v);
      return;
    }
    const sep =
      param.style === "spaceDelimited" ? " " : param.style === "pipeDelimited" ? "|" : ",";
    query.append(key, items.join(sep));
    return;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (param.style === "deepObject") {
      // deepObject → key[prop]=value (always exploded).
      for (const [k, v] of entries) query.append(`${key}[${k}]`, stringify(v));
      return;
    }
    if (param.explode) {
      // form + explode → prop=value for each property (key itself dropped).
      for (const [k, v] of entries) query.append(k, stringify(v));
      return;
    }
    // form, no explode → key=prop1,value1,prop2,value2
    query.append(key, entries.map(([k, v]) => `${k},${stringify(v)}`).join(","));
    return;
  }

  query.append(key, stringify(value));
}

function mergeCookies(credential: string, params: string): string {
  const name = credential.slice(0, credential.indexOf("=") + 1);
  return [credential, ...params.split("; ").filter((pair) => !pair.startsWith(name))].join("; ");
}

function appendCookie(existing: string | undefined, key: string, value: string): string {
  const pair = `${key}=${value}`;
  return existing ? `${existing}; ${pair}` : pair;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip query string from a URL for safer logging. */
function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
