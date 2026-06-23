/**
 * Core domain types shared across the ingestion → generation → runtime pipeline.
 */

/** Where a parameter is placed in the outgoing HTTP request. */
export type ParamLocation = "path" | "query" | "header" | "cookie";

/** A single input parameter on a generated MCP tool. */
export interface ToolParam {
  /** Property name exposed to the agent (sanitized for safety). */
  name: string;
  /** Original name in the spec (used when building the request). */
  sourceName: string;
  location: ParamLocation;
  required: boolean;
  description?: string;
  /** JSON Schema fragment for this parameter, straight from the spec. */
  schema: JsonSchema;
}

/**
 * A request body mapped to a single `body` argument on the tool. We keep the
 * raw JSON Schema so the runtime can forward it verbatim to the upstream API.
 */
export interface ToolBody {
  required: boolean;
  description?: string;
  contentType: string;
  schema: JsonSchema;
}

/** A fully-described MCP tool, ready to be registered and proxied. */
export interface ToolDef {
  /** MCP tool name, unique within a server. */
  name: string;
  description: string;
  /** HTTP method, uppercased. */
  method: string;
  /** Path template with `{param}` placeholders, relative to baseUrl. */
  pathTemplate: string;
  params: ToolParam[];
  body?: ToolBody;
  /** Security scheme names this operation requires (OR semantics). */
  security: string[];
}

/** The product of ingestion + generation: everything the runtime needs. */
export interface GeneratedServer {
  name: string;
  version: string;
  /** Resolved upstream base URL all requests are made against. */
  baseUrl: string;
  tools: ToolDef[];
  securitySchemes: Record<string, SecurityScheme>;
}

/** Subset of OpenAPI security schemes we support today. */
export type SecurityScheme =
  | { type: "http"; scheme: "bearer" | "basic"; name: string }
  | { type: "apiKey"; in: "header" | "query" | "cookie"; paramName: string; name: string };

/** A permissive JSON Schema shape; we only read the fields we map. */
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  nullable?: boolean;
  [key: string]: unknown;
}
